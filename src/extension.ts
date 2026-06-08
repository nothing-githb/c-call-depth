// src/extension.ts
import * as vscode from "vscode";
import * as path from "path";
import * as fs from "fs";
import {
  FunctionRecord,
  DepthInfo
} from "./callGraph";
import { runPythonBackend } from "./pythonBackend";
import { buildFpTemplate, fpTemplateToJson } from "./fpTemplate";
import {
  applyDecorations,
  makeHoverProvider,
  disposeDecorationTypes,
  normPath,
  DisplayConfig,
  DisplayState
} from "./displayProviders";
import { SidePanelProvider, SidePanelState } from "./sidePanel";
import { GraphView } from "./graphView";
import { Logger } from "./logger";
import { buildRows, buildCsv, buildHtml } from "./reporter";

interface AnalysisState {
  byName: Map<string, FunctionRecord>;
  byFile: Map<string, FunctionRecord[]>;
  depth: Map<string, DepthInfo>;
  pinnedRoots: Set<string>;
}

let state: AnalysisState = {
  byName: new Map(),
  byFile: new Map(),
  depth: new Map(),
  pinnedRoots: new Set()
};

let log: Logger;
let analysisRunning = false;
let analysisQueued = false;
let saveDebounce: NodeJS.Timeout | undefined;

/** Wipe the per-TU parse cache so the next analysis re-parses everything from
 *  scratch. Used by the "Clear cache and refresh" command for a clean rebuild
 *  when the cache may be stale or the user wants a forced full re-parse. */
function clearTuCache() {
  if (!cacheDir) return;
  try {
    for (const f of fs.readdirSync(cacheDir)) {
      if (f.endsWith(".json")) {
        try { fs.unlinkSync(path.join(cacheDir, f)); } catch { /* ignore */ }
      }
    }
    log.info("cache", "per-TU cache cleared");
  } catch (e: any) {
    log.warn("cache", "could not clear cache: " + (e?.message ?? String(e)));
  }
}

/** Coalesce bursty triggers (e.g. a git checkout touching many files, or a
 *  build writing dozens of .su files at once) into a single analysis run. */
function scheduleAnalysisDebounced(delayMs = 800) {
  if (saveDebounce) clearTimeout(saveDebounce);
  saveDebounce = setTimeout(() => scheduleAnalysis(), delayMs);
}
let currentCancel: vscode.CancellationTokenSource | undefined;
let sidePanel: SidePanelProvider | undefined;
let graphView: GraphView | undefined;
let statusBarItem: vscode.StatusBarItem | undefined;
let extensionPath = "";
let cacheDir = "";

export async function activate(context: vscode.ExtensionContext) {
  extensionPath = context.extensionPath;
  // Per-TU parse cache lives in the extension's global storage so incremental
  // analysis survives across sessions and doesn't clutter the workspace.
  try {
    cacheDir = path.join(context.globalStorageUri.fsPath, "tu-cache");
    fs.mkdirSync(cacheDir, { recursive: true });
  } catch { cacheDir = ""; }
  const channel = vscode.window.createOutputChannel("C Stack Analysis & Call Graph");
  context.subscriptions.push(channel);
  log = new Logger(channel);

  statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  statusBarItem.command = "cCallDepth.showOutput";
  context.subscriptions.push(statusBarItem);

  // Headers are often classified as "cpp"; register for both so hover works in
  // .h files too. The provider itself only fires on a matched function name.
  const cSelector: vscode.DocumentSelector = [
    { language: "c", scheme: "file" },
    { language: "cpp", scheme: "file" }
  ];

  context.subscriptions.push(
    vscode.languages.registerHoverProvider(
      cSelector,
      makeHoverProvider(() => state as DisplayState, getDisplayConfig)
    )
  );

  sidePanel = new SidePanelProvider({
    getState: (): SidePanelState => {
      const cfg = getDisplayConfig();
      return {
        byName: state.byName,
        depth: state.depth,
        pathsLimit: cfg.pathsLimit,
        pathsMaxDepth: cfg.pathsMaxDepth,
        pinnedRoots: state.pinnedRoots,
        thresholdWarn: cfg.thresholdWarn,
        thresholdCritical: cfg.thresholdCritical
      };
    }
  });
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(SidePanelProvider.viewType, sidePanel)
  );

  graphView = new GraphView({
    getState: () => {
      const cfg = getDisplayConfig();
      return {
        byName: state.byName,
        depth: state.depth,
        pinnedRoots: state.pinnedRoots,
        thresholdWarn: cfg.thresholdWarn,
        thresholdCritical: cfg.thresholdCritical
      };
    },
    openFunction: (name: string) => gotoFunction(name),
    showStack: (name: string) => {
      if (sidePanel) sidePanel.lookupFunction(name);
    },
    log: (msg: string) => log.error("graph-webview", msg)
  });

  context.subscriptions.push(
    vscode.commands.registerCommand("cCallDepth.refresh", () => scheduleAnalysis()),
    vscode.commands.registerCommand("cCallDepth.clearCacheAndRefresh", () => {
      clearTuCache();
      scheduleAnalysis();
    }),
    vscode.commands.registerCommand("cCallDepth.focusSidePanel", () =>
      vscode.commands.executeCommand("cCallDepth.sidePanel.focus")
    ),
    vscode.commands.registerCommand("cCallDepth.showOutput", () => log.show()),
    vscode.commands.registerCommand("cCallDepth.exportReport", () => exportReport()),
    vscode.commands.registerCommand("cCallDepth.generateFpOverrides", () => generateFpOverrides()),
    vscode.commands.registerCommand("cCallDepth.gotoFunction", (name: string) => gotoFunction(name)),
    vscode.commands.registerCommand("cCallDepth.lookupInPanel", (name: string) => {
      if (sidePanel && typeof name === "string") sidePanel.lookupFunction(name);
    }),
    vscode.commands.registerCommand("cCallDepth.openGraph", (name?: string) => {
      // If invoked without an explicit name, try the symbol under the cursor.
      let focus = typeof name === "string" ? name : undefined;
      if (!focus) {
        const ed = vscode.window.activeTextEditor;
        if (ed && ed.document.languageId === "c") {
          const range = ed.document.getWordRangeAtPosition(ed.selection.active);
          if (range) {
            const word = ed.document.getText(range);
            if (state.byName.has(word)) focus = word;
          }
        }
      }
      graphView?.show(focus);
    }),
    vscode.commands.registerCommand("cCallDepth.openGraphFromRoot",
      (arg?: { root?: string; target?: string; depth?: number }) => {
        // Invoked from the side panel's per-root table: show the path from a
        // specific root down to the target function in the call graph.
        if (!arg || !arg.root || !arg.target) return;
        if (!state.byName.has(arg.root)) return;
        graphView?.show(arg.target, { fromRoot: arg.root, depthHint: arg.depth });
      })
  );

  context.subscriptions.push(
    vscode.window.onDidChangeActiveTextEditor(() => updateAllVisibleDecorations()),
    vscode.window.onDidChangeVisibleTextEditors(() => updateAllVisibleDecorations()),
    vscode.workspace.onDidChangeConfiguration(e => {
      if (e.affectsConfiguration("cCallDepth")) {
        disposeDecorationTypes();
        updateAllVisibleDecorations();
        // If display-only config changed, no need to rerun analysis. But if
        // it's a content-affecting setting (suDir, rootPatterns), rerun.
        const contentKeys = [
          "cCallDepth.suDirectory",
          "cCallDepth.rootPatterns",
          "cCallDepth.compileCommandsDir",
          "cCallDepth.pythonPath",
          "cCallDepth.libclangPath",
          "cCallDepth.clangArgs",
          "cCallDepth.fpOverridesPath"
        ];
        for (const k of contentKeys) if (e.affectsConfiguration(k)) {
          // If the fp-overrides path itself changed, re-point the custom
          // watcher at the new file so future edits to it auto-refresh too.
          if (e.affectsConfiguration("cCallDepth.fpOverridesPath")) {
            rewatchCustomFpOverrides?.();
          }
          if (e.affectsConfiguration("cCallDepth.compileCommandsDir")) {
            loadCompileCommandsSet?.();
          }
          scheduleAnalysis();
          return;
        }
      }
    })
  );

  // ── Auto-refresh scope ──────────────────────────────────────────────────
  // Only files that are translation units listed in compile_commands.json may
  // trigger an automatic re-analysis. Editing any other file in the workspace
  // (headers, sources not in the build, docs, …) is ignored — use the manual
  // "Refresh analysis" command for those.
  let tuPaths = new Set<string>();
  const normPath = (p: string) => path.resolve(p).replace(/\\/g, "/").toLowerCase();
  const resolveCompileCommandsPath = (): string | undefined => {
    const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!root) { return undefined; }
    const setting = vscode.workspace.getConfiguration("cCallDepth").get<string>("compileCommandsDir", "");
    const cands: string[] = [];
    if (setting) {
      const abs = path.isAbsolute(setting) ? setting : path.join(root, setting);
      cands.push(/compile_commands\.json$/i.test(abs) ? abs : path.join(abs, "compile_commands.json"));
    }
    cands.push(path.join(root, "compile_commands.json"));
    cands.push(path.join(root, "build", "compile_commands.json"));
    for (const c of cands) { try { if (fs.existsSync(c)) { return c; } } catch { /* ignore */ } }
    return undefined;
  };
  const loadCompileCommandsSet = () => {
    const next = new Set<string>();
    try {
      const ccPath = resolveCompileCommandsPath();
      if (ccPath) {
        const txt = fs.readFileSync(ccPath, "utf8").replace(/^\uFEFF/, "");
        const entries = JSON.parse(txt);
        if (Array.isArray(entries)) {
          for (const e of entries) {
            if (e && typeof e.file === "string") {
              const dir = typeof e.directory === "string" ? e.directory : path.dirname(ccPath);
              const abs = path.isAbsolute(e.file) ? e.file : path.resolve(dir, e.file);
              next.add(normPath(abs));
            }
          }
        }
      }
    } catch { /* leave empty on parse error — nothing auto-refreshes from sources */ }
    tuPaths = next;
    log.info("watch", `auto-refresh scope: ${tuPaths.size} translation unit(s) from compile_commands.json`);
  };
  const isTrackedTU = (fsPath: string) => tuPaths.has(normPath(fsPath));
  loadCompileCommandsSet();

  context.subscriptions.push(
    vscode.workspace.onDidSaveTextDocument(doc => {
      // Re-analyze only when a compile_commands.json translation unit is saved.
      if (!isTrackedTU(doc.fileName)) { return; }
      scheduleAnalysisDebounced();
    })
  );

  // Watch for build-output / project changes to re-analyze automatically:
  // .su files (stack frames) and compile_commands.json (the file set).
  const suWatcher = vscode.workspace.createFileSystemWatcher("**/*.su");
  const ccWatcher = vscode.workspace.createFileSystemWatcher("**/compile_commands.json");
  // Watch C sources on disk so external changes (git checkout, build) to a
  // translation unit re-analyze too. The glob is broad, but the handlers below
  // only act when the changed file is actually a compile_commands.json TU
  // (isTrackedTU) — edits to any other file (headers, non-build sources) are
  // ignored; use the manual "Refresh analysis" command for those.
  const srcWatcher = vscode.workspace.createFileSystemWatcher("**/*.{c,h,cc,cpp,cxx,hpp,hh}");
  // The fp-overrides JSON (manual function-pointer verification) affects the
  // analysis, so re-analyze when it changes. We watch the conventional name
  // anywhere, AND — if the user pointed cCallDepth.fpOverridesPath at a custom
  // path — that exact file too (its name may not be "fp-overrides.json").
  const fpOvWatcher = vscode.workspace.createFileSystemWatcher("**/fp-overrides.json");
  let fpCustomWatcher: vscode.FileSystemWatcher | undefined;
  const rewatchCustomFpOverrides = () => {
    fpCustomWatcher?.dispose();
    fpCustomWatcher = undefined;
    const setting = vscode.workspace.getConfiguration("cCallDepth").get<string>("fpOverridesPath", "");
    if (!setting) return;                       // default name already covered
    const base = path.basename(setting);
    if (base === "fp-overrides.json") return;   // already covered by fpOvWatcher
    const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    const abs = path.isAbsolute(setting) ? setting : (root ? path.join(root, setting) : setting);
    fpCustomWatcher = vscode.workspace.createFileSystemWatcher(abs);
    fpCustomWatcher.onDidChange(() => scheduleAnalysisDebounced());
    fpCustomWatcher.onDidCreate(() => scheduleAnalysisDebounced());
    fpCustomWatcher.onDidDelete(() => scheduleAnalysisDebounced());
  };
  rewatchCustomFpOverrides();
  context.subscriptions.push(
    suWatcher,
    suWatcher.onDidChange(() => scheduleAnalysisDebounced()),
    suWatcher.onDidCreate(() => scheduleAnalysisDebounced()),
    suWatcher.onDidDelete(() => scheduleAnalysisDebounced()),
    ccWatcher,
    ccWatcher.onDidChange(() => { loadCompileCommandsSet(); scheduleAnalysisDebounced(); }),
    ccWatcher.onDidCreate(() => { loadCompileCommandsSet(); scheduleAnalysisDebounced(); }),
    ccWatcher.onDidDelete(() => { loadCompileCommandsSet(); scheduleAnalysisDebounced(); }),
    srcWatcher,
    srcWatcher.onDidChange(u => { if (isTrackedTU(u.fsPath)) { scheduleAnalysisDebounced(); } }),
    srcWatcher.onDidCreate(u => { if (isTrackedTU(u.fsPath)) { scheduleAnalysisDebounced(); } }),
    srcWatcher.onDidDelete(u => { if (isTrackedTU(u.fsPath)) { scheduleAnalysisDebounced(); } }),
    fpOvWatcher,
    fpOvWatcher.onDidChange(() => scheduleAnalysisDebounced()),
    fpOvWatcher.onDidCreate(() => scheduleAnalysisDebounced()),
    fpOvWatcher.onDidDelete(() => scheduleAnalysisDebounced()),
    { dispose: () => fpCustomWatcher?.dispose() }
  );

  // The analyzer uses libclang via the bundled Python CLI; clangd is not
  // required. Any missing-Python/libclang condition is reported by the
  // analysis run itself with an actionable message.
  setStatus("waiting…");
  setTimeout(() => scheduleAnalysis(), 1500);
}

export function deactivate() {
  currentCancel?.cancel();
  disposeDecorationTypes();
}

function setStatus(text: string, severity?: "warning" | "error") {
  if (!statusBarItem) return;
  statusBarItem.text = `$(symbol-method) ${text}`;
  statusBarItem.tooltip = "Click to view C Stack Analysis & Call Graph log";
  if (severity === "warning") {
    statusBarItem.backgroundColor = new vscode.ThemeColor("statusBarItem.warningBackground");
  } else if (severity === "error") {
    statusBarItem.backgroundColor = new vscode.ThemeColor("statusBarItem.errorBackground");
  } else {
    statusBarItem.backgroundColor = undefined;
  }
  statusBarItem.show();
}

function getDisplayConfig(): DisplayConfig {
  const cfg = vscode.workspace.getConfiguration("cCallDepth");
  return {
    mode: cfg.get<string>("displayMode", "decoration") === "hover" ? "hover" : "decoration",
    thresholdWarn: cfg.get<number>("stackThresholds.warn", 1024),
    thresholdCritical: cfg.get<number>("stackThresholds.critical", 4096),
    pathsLimit: cfg.get<number>("pathsLimit", 5),
    pathsMaxDepth: cfg.get<number>("pathsMaxDepth", 32)
  };
}

function isCDoc(doc: vscode.TextDocument): boolean {
  // Decorations/hover apply to C sources AND headers. Headers are frequently
  // classified as "cpp" (or the C++ tooling claims .h), so accept both langs
  // and fall back to the file extension when the languageId is something else.
  if (doc.languageId === "c" || doc.languageId === "cpp") return true;
  return /\.(c|h|cc|cpp|cxx|hpp|hh)$/i.test(doc.uri.fsPath);
}

function updateAllVisibleDecorations() {
  const cfg = getDisplayConfig();
  for (const editor of vscode.window.visibleTextEditors) {
    if (!isCDoc(editor.document)) continue;
    applyDecorations(editor, state, cfg);
  }
}

function scheduleAnalysis() {
  if (analysisRunning) {
    analysisQueued = true;
    currentCancel?.cancel();
    return;
  }
  analysisRunning = true;
  currentCancel = new vscode.CancellationTokenSource();
  const token = currentCancel.token;
  runAnalysis(token)
    .catch(err => log.error("error", err?.stack || String(err)))
    .finally(() => {
      currentCancel?.dispose();
      currentCancel = undefined;
      analysisRunning = false;
      updateAllVisibleDecorations();
      sidePanel?.notifyAnalysisUpdated();
      graphView?.refresh();
      if (analysisQueued) {
        analysisQueued = false;
        scheduleAnalysis();
      }
    });
}

function resolveSuDirectory(userValue: string): string | undefined {
  if (!userValue) return undefined;
  if (path.isAbsolute(userValue)) return userValue;
  const folders = vscode.workspace.workspaceFolders;
  if (!folders || folders.length === 0) return undefined;
  return path.join(folders[0].uri.fsPath, userValue);
}

async function runAnalysis(token: vscode.CancellationToken) {
  const cfg = vscode.workspace.getConfiguration("cCallDepth");
  const logLevel = (cfg.get<string>("logLevel", "info") as any) || "info";
  log.setLevel(logLevel);
  const maxDepth = cfg.get<number>("maxDepthForCumulative", 64);
  const suDirSetting = cfg.get<string>("suDirectory", "");
  const rootPatterns = cfg.get<string[]>("rootPatterns", []);
  await runPythonAnalysis(cfg, suDirSetting, rootPatterns, maxDepth, token);
}

// ───────────────────────── (legacy LSP pipeline removed) ─────────────────

/** Run the standalone Python analyzer and install its result as the state. */
async function runPythonAnalysis(
  cfg: vscode.WorkspaceConfiguration,
  suDir: string,
  rootPatterns: string[],
  maxDepth: number,
  token: vscode.CancellationToken
) {
  const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (!root) {
    log.error("python", "no workspace folder open");
    setStatus("no workspace", "warning");
    return;
  }
  const pythonPath = cfg.get<string>("pythonPath", "python3");
  const libclangPath = cfg.get<string>("libclangPath", "");
  const clangArgs = cfg.get<string[]>("clangArgs", []);
  const compileCommandsDirSetting = cfg.get<string>("compileCommandsDir", "");
  const compileCommandsDir = compileCommandsDirSetting
    ? (resolveSuDirectory(compileCommandsDirSetting) ?? compileCommandsDirSetting)
    : "";
  const resolvedSu = suDir ? resolveSuDirectory(suDir) ?? "" : "";
  // Resolve the fp-overrides JSON: explicit setting, else <root>/fp-overrides.json.
  const fpOverridesSetting = cfg.get<string>("fpOverridesPath", "");
  let fpOverridesPath = "";
  if (fpOverridesSetting) {
    fpOverridesPath = path.isAbsolute(fpOverridesSetting)
      ? fpOverridesSetting : path.join(root, fpOverridesSetting);
  } else {
    const def = path.join(root, "fp-overrides.json");
    if (fs.existsSync(def)) fpOverridesPath = def;
  }

  setStatus("analyzing (libclang)…");
  const tStart = Date.now();
  log.info("run", "===== analysis starting (python-cli / libclang backend) =====");
  const endPhase = log.beginPhase("python", "running libclang analyzer");

  let result;
  try {
    result = await runPythonBackend({
      extensionPath,
      pythonPath,
      libclangPath,
      clangArgs,
      compileCommandsDir,
      cacheDir,
      fpOverridesPath,
      root,
      suDir: resolvedSu,
      rootPatterns,
      maxDepth,
      token,
      log: {
        info: (c, m) => log.info(c, m),
        warn: (c, m) => log.warn(c, m),
        error: (c, m) => log.error(c, m),
      },
      onProgress: line => setStatus(`analyzing (libclang)… ${line}`.slice(0, 60)),
    });
  } catch (e: any) {
    endPhase();
    if (token.isCancellationRequested) { log.info("run", "cancelled"); return; }
    log.error("python", e?.message || String(e));
    setStatus("python backend error", "error");
    return;
  }
  endPhase();
  if (token.isCancellationRequested) { log.info("run", "cancelled"); return; }

  // Rebuild byFile from the records, keyed by NORMALIZED path so the
  // decoration/hover lookups (which normalize the editor's fsPath) match.
  const byFile = new Map<string, FunctionRecord[]>();
  for (const rec of result.byName.values()) {
    const key = normPath(rec.file);
    if (!byFile.has(key)) { byFile.set(key, []); }
    byFile.get(key)!.push(rec);
  }

  state = {
    byName: result.byName,
    byFile,
    depth: result.depth,
    pinnedRoots: result.pinnedRoots,
  };

  const stackKnown = [...result.byName.values()].filter(r => r.stackBytes !== undefined).length;
  log.summary("analysis complete (python)", [
    ["functions", result.byName.size],
    ["with stack", stackKnown],
    ["pinned roots", result.pinnedRoots.size],
    ["total elapsed", `${Date.now() - tStart}ms`],
  ]);
  setStatus(`${result.byName.size} fn · ${stackKnown} with stack · py`);
}

// ──────────────────────────────────────────────────────────────────────
// Report export
// ──────────────────────────────────────────────────────────────────────
async function exportReport() {
  if (state.byName.size === 0) {
    vscode.window.showWarningMessage(
      "No analysis available — run 'C Call Depth: Refresh analysis' first."
    );
    return;
  }
  const cfg = getDisplayConfig();
  const reportCfg = { thresholdWarn: cfg.thresholdWarn, thresholdCritical: cfg.thresholdCritical };
  const wsFolder = vscode.workspace.workspaceFolders?.[0];
  const wsPath = wsFolder?.uri.fsPath ?? "";

  // Always export roots only (one row per entry point) — no prompt.
  const rows = buildRows(state.byName, state.depth, state.pinnedRoots, reportCfg, true);

  const format = await vscode.window.showQuickPick(
    [
      { label: "HTML — formatted, severity-colored, opens in browser", value: "html" },
      { label: "CSV — for spreadsheets, traceability, version control", value: "csv" },
      { label: "Both", value: "both" }
    ],
    { placeHolder: "Report format" }
  );
  if (!format) return;

  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const baseName = `c-call-depth-report-${stamp}`;
  const meta = {
    workspace: wsFolder?.name ?? wsPath ?? "(unknown)",
    generatedAt: new Date(),
    totalFunctions: state.byName.size,
    pinnedRoots: state.pinnedRoots.size
  };

  const written: string[] = [];
  try {
    if (format.value === "html" || format.value === "both") {
      const htmlPath = path.join(wsPath, `${baseName}.html`);
      fs.writeFileSync(htmlPath, buildHtml(rows, reportCfg, meta), "utf8");
      written.push(htmlPath);
    }
    if (format.value === "csv" || format.value === "both") {
      const csvPath = path.join(wsPath, `${baseName}.csv`);
      fs.writeFileSync(csvPath, buildCsv(rows), "utf8");
      written.push(csvPath);
    }
  } catch (e: any) {
    vscode.window.showErrorMessage(`Could not write report: ${e?.message ?? e}`);
    return;
  }

  log.summary("report exported", [
    ["rows", rows.length],
    ...written.map(p => ["file", p] as [string, string])
  ]);

  const action = await vscode.window.showInformationMessage(
    `Report exported (${rows.length} rows × ${written.length} file${written.length > 1 ? "s" : ""})`,
    "Open HTML", "Open folder"
  );
  if (action === "Open HTML") {
    const htmlPath = written.find(p => p.endsWith(".html"));
    if (htmlPath) vscode.env.openExternal(vscode.Uri.file(htmlPath));
  } else if (action === "Open folder") {
    vscode.commands.executeCommand("revealFileInOS", vscode.Uri.file(written[0]));
  }
}

/** Generate an fp-overrides.json template from the current analysis: one entry
 *  per UNRESOLVED / over-approximated function-pointer call site (so the user
 *  can fill in the real targets instead of writing the file from scratch). */
async function generateFpOverrides() {
  if (state.byName.size === 0) {
    vscode.window.showWarningMessage(
      "No analysis available — run 'C Call Depth: Refresh analysis' first."
    );
    return;
  }

  // Collect every fp call site that isn't already covered by an override.
  // Each becomes a skeleton entry keyed by (caller, via, line) with the
  // auto-resolved candidates pre-filled. The builder is pure (see fpTemplate.ts)
  // and unit-tested, so the actual generated output is covered by tests.
  const { entries, covered } = buildFpTemplate(state.depth, state.byName);

  if (entries.length === 0) {
    vscode.window.showInformationMessage(
      covered > 0
        ? `All ${covered} function-pointer call site(s) are already covered by overrides.`
        : "No function-pointer call sites found in this analysis."
    );
    return;
  }

  const text = fpTemplateToJson({ entries, covered });
  const document = await vscode.workspace.openTextDocument({ language: "json", content: text });
  await vscode.window.showTextDocument(document);

  log.summary("fp-overrides template generated", [
    ["unresolved sites", entries.length],
    ["already covered", covered]
  ]);

  const action = await vscode.window.showInformationMessage(
    `fp-overrides template: ${entries.length} call site(s) to fill in` +
      (covered ? ` (${covered} already covered)` : "") +
      ". Save it as fp-overrides.json in your workspace.",
    "Save as…"
  );
  if (action === "Save as…") {
    const wsFolder = vscode.workspace.workspaceFolders?.[0];
    const defaultUri = wsFolder
      ? vscode.Uri.file(path.join(wsFolder.uri.fsPath, "fp-overrides.json"))
      : undefined;
    const target = await vscode.window.showSaveDialog({
      defaultUri,
      filters: { JSON: ["json"] }
    });
    if (target) {
      try {
        fs.writeFileSync(target.fsPath, text, "utf8");
        vscode.window.showInformationMessage(
          `Saved ${path.basename(target.fsPath)}. Set cCallDepth.fpOverridesPath if it isn't at the workspace root.`
        );
      } catch (e: any) {
        vscode.window.showErrorMessage(`Could not save: ${e?.message ?? e}`);
      }
    }
  }
}

/** Open the file containing `name` and reveal its definition line. */
function gotoFunction(name: string) {
  const fn = state.byName.get(name);
  if (!fn) {
    vscode.window.showInformationMessage(`No analysis record for "${name}".`);
    return;
  }
  if (fn.ghost) {
    vscode.window.showInformationMessage(
      `"${name}" is a ghost record (.su-only, libclang never saw it). Cannot navigate.`
    );
    return;
  }
  const uri = vscode.Uri.file(fn.file);
  vscode.window.showTextDocument(uri).then(editor => {
    const pos = new vscode.Position(fn.nameLine, fn.nameCol);
    editor.selection = new vscode.Selection(pos, pos);
    editor.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.InCenter);
  });
}
