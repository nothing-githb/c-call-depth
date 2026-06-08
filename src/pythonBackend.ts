import * as vscode from "vscode";
import * as cp from "child_process";
import * as path from "path";
import { FunctionRecord, DepthInfo, PerRootAnalysis } from "./callGraph";

/** Result of the Python CLI, mapped into the extension's data structures. */
export interface PythonAnalysisResult {
  byName: Map<string, FunctionRecord>;
  depth: Map<string, DepthInfo>;
  pinnedRoots: Set<string>;
}

interface PyLogger {
  info: (c: string, m: string) => void;
  warn: (c: string, m: string) => void;
  error: (c: string, m: string) => void;
}

/**
 * Run the bundled Python analyzer (cdepth_cli) as a child process. It parses
 * every translation unit with libclang and extracts the call graph from the
 * AST — no clangd, no VS Code LSP, no GCC .expand — then prints a JSON result
 * we parse here (byName + per-root depth/peak), so the rest of the extension
 * is unchanged.
 */
export async function runPythonBackend(opts: {
  extensionPath: string;
  pythonPath: string;
  libclangPath: string;
  clangArgs: string[];
  compileCommandsDir: string;
  cacheDir?: string;
  fpOverridesPath?: string;
  edgeRemovalsPath?: string;
  root: string;
  suDir: string;
  rootPatterns: string[];
  maxDepth: number;
  token: vscode.CancellationToken;
  log: PyLogger;
  onProgress?: (line: string) => void;
}): Promise<PythonAnalysisResult> {
  const args = [
    "-m", "cdepth_cli",
    "--root", opts.root,
    "--max-depth", String(opts.maxDepth),
    "--json",
    "--verbose",
  ];
  if (opts.suDir) { args.push("--su-dir", opts.suDir); }
  if (opts.compileCommandsDir) { args.push(`--compile-commands-dir=${opts.compileCommandsDir}`); }
  if (opts.cacheDir) { args.push(`--cache-dir=${opts.cacheDir}`); }
  if (opts.fpOverridesPath) { args.push(`--fp-overrides=${opts.fpOverridesPath}`); }
  if (opts.edgeRemovalsPath) { args.push(`--edge-removals=${opts.edgeRemovalsPath}`); }
  if (opts.libclangPath) { args.push(`--libclang=${opts.libclangPath}`); }
  for (const p of opts.rootPatterns) { args.push(`--root-pattern=${p}`); }
  for (const a of opts.clangArgs) { args.push(`--clang-arg=${a}`); }

  opts.log.info("python", `running: ${opts.pythonPath} ${args.join(" ")}`);
  opts.log.info("python", `cwd (PYTHONPATH): ${opts.extensionPath}`);

  return new Promise<PythonAnalysisResult>((resolve, reject) => {
    const child = cp.spawn(opts.pythonPath, args, {
      cwd: opts.extensionPath,
      env: { ...process.env, PYTHONPATH: opts.extensionPath },
    });

    let stdout = "";
    let stderrTail: string[] = [];
    const killOnCancel = opts.token.onCancellationRequested(() => {
      try { child.kill(); } catch { /* ignore */ }
    });

    child.stdout.on("data", d => { stdout += d.toString(); });
    child.stderr.on("data", d => {
      const text = d.toString();
      for (const line of text.split(/\r?\n/)) {
        if (!line.trim()) { continue; }
        stderrTail.push(line);
        if (stderrTail.length > 40) { stderrTail.shift(); }
        // Surface progress lines (the CLI logs "[cdepth] ..." to stderr).
        opts.onProgress?.(line.replace(/^\[cdepth\]\s*/, ""));
        opts.log.info("python", line.replace(/^\[cdepth\]\s*/, ""));
      }
    });

    child.on("error", err => {
      killOnCancel.dispose();
      reject(new Error(
        `failed to launch Python backend (${opts.pythonPath}): ${err.message}. ` +
        `Set cCallDepth.pythonPath to a valid Python 3 interpreter.`));
    });

    child.on("close", code => {
      killOnCancel.dispose();
      if (opts.token.isCancellationRequested) {
        reject(new Error("cancelled"));
        return;
      }
      if (code !== 0) {
        reject(new Error(
          `Python backend exited with code ${code}.\n` +
          stderrTail.slice(-12).join("\n")));
        return;
      }
      try {
        const parsed = JSON.parse(stdout);
        resolve(mapResult(parsed));
      } catch (e: any) {
        reject(new Error(`could not parse Python backend JSON: ${e?.message || e}`));
      }
    });
  });
}

/** Map the CLI's JSON schema into FunctionRecord + DepthInfo maps. */
function mapResult(parsed: any): PythonAnalysisResult {
  const byName = new Map<string, FunctionRecord>();
  const depth = new Map<string, DepthInfo>();
  const pinnedRoots = new Set<string>(parsed.pinnedRoots ?? []);

  const bn = parsed.byName ?? {};
  for (const name of Object.keys(bn)) {
    const r = bn[name];
    byName.set(name, {
      name,
      file: r.file,
      nameLine: r.line ?? 0,
      nameCol: 0,
      callees: Array.isArray(r.callees) ? r.callees.slice() : [],
      indirectCallees: Array.isArray(r.indirect) ? r.indirect.slice() : [],
      stackBytes: r.stackBytes ?? undefined,
      stackQualifier: r.stackQualifier ?? undefined,
    });

    const perRoot: PerRootAnalysis[] = (r.perRoot ?? []).map((e: any) => ({
      rootName: e.root,
      depth: e.depth,
      cumulativeStack: e.peak ?? undefined,
      cumulativeBounded: e.peakBounded === true,
      isAuto: e.isAuto === true,
    }));

    depth.set(name, {
      depth: r.depth ?? 0,
      downDepth: r.downDepth ?? 0,
      downDepthBounded: r.downDepthBounded === true,
      isPinnedRoot: r.isPinnedRoot === true,
      isAutoRoot: r.isAutoRoot === true,
      cumulativeStack: r.peak ?? undefined,
      cumulativeBounded: r.peakBounded === true,
      recursive: r.recursive === true,
      recursiveViaFp: r.recursiveViaFp === true,
      fpVerified: r.fpVerified === true,
      fpSites: Array.isArray(r.fpSites) ? r.fpSites : [],
      perRoot,
    });
  }

  return { byName, depth, pinnedRoots };
}
