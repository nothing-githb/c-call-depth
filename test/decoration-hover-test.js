// Decoration + hover provider tests (no live VS Code).
// Stubs the `vscode` module, then drives applyDecorations() and the
// HoverProvider with fake editors/documents to verify:
//   1. decorations are emitted in "decoration" mode (and cleared in "hover" mode)
//   2. the editor path is matched even when separators/case differ (normPath)
//   3. hover returns markdown in "hover" mode and nothing in "decoration" mode
//   4. hover fires only on the function's definition line
//
// Usage: node test/decoration-hover-test.js
const Module = require("module");

// --- vscode stub --------------------------------------------------------------
let lastSetDecorations = {}; // decTypeId -> options[]
let _decTypeCounter = 0;
function makeDecType() { return { _id: "dec" + (_decTypeCounter++) }; }
const vscodeStub = {
  EventEmitter: class { constructor(){ this.event = () => ({ dispose(){} }); } fire(){} },
  Uri: { joinPath: (...a) => ({ fsPath: a.join("/") }), file: (p) => ({ fsPath: p }) },
  window: {
    createTextEditorDecorationType: () => makeDecType(),
    visibleTextEditors: [],
  },
  workspace: { getConfiguration: () => ({ get: (_k, d) => d }) },
  Range: class { constructor(a, b){ this.start = a; this.end = b; } },
  Position: class { constructor(line, ch){ this.line = line; this.character = ch; } },
  Hover: class { constructor(c, r){ this.contents = Array.isArray(c) ? c : [c]; this.range = r; } },
  MarkdownString: class {
    constructor(){ this.value = ""; this.isTrusted = false; this.supportHtml = false; }
    appendMarkdown(s){ this.value += s; return this; }
    appendText(s){ this.value += s; return this; }
    appendCodeblock(s){ this.value += s; return this; }
  },
  ThemeColor: class { constructor(id){ this.id = id; } },
  OverviewRulerLane: { Right: 7 },
  DecorationRangeBehavior: { ClosedClosed: 1 },
};
const realLoad = Module._load;
Module._load = function (request) {
  if (request === "vscode") return vscodeStub;
  return realLoad.apply(this, arguments);
};

const { applyDecorations, makeHoverProvider, normPath } = require("../out/displayProviders.js");

// --- Build a fake analysis state ---------------------------------------------
// rec.file is an absolute path with forward slashes (as the CLI emits).
const FILE = "/tmp/ws/app/app.c";
const recApp = {
  name: "app_main", file: FILE, nameLine: 8, nameCol: 4,
  stackBytes: 128, stackQualifier: "", callees: ["worker"], ghost: false,
};
const recWorker = {
  name: "worker", file: FILE, nameLine: 20, nameCol: 4,
  stackBytes: 64, stackQualifier: "", callees: [], ghost: false,
};
const depth = new Map([
  ["app_main", { depth: 1, recursive: false, cumulativeStack: 4800, cumulativeBounded: false,
                 fpVerified: false, fpSites: [],
                 perRoot: [{ rootName: "app_main", depth: 1, cumulativeStack: 4800, isAuto: false }] }],
  ["worker",   { depth: 2, recursive: false, cumulativeStack: 64, cumulativeBounded: false,
                 fpVerified: false, fpSites: [],
                 perRoot: [{ rootName: "app_main", depth: 2, cumulativeStack: 64 }] }],
]);
// byFile keyed by NORMALIZED path, exactly as the extension builds it.
const byFile = new Map([[normPath(FILE), [recApp, recWorker]]]);
const byName = new Map([["app_main", recApp], ["worker", recWorker]]);
const state = { byName, byFile, depth, pinnedRoots: new Set(["app_main"]) };

// --- Fake editor/document -----------------------------------------------------
function fakeEditor(fsPath) {
  const setCalls = {};
  return {
    document: {
      uri: { fsPath },
      languageId: "c",
      lineAt: (n) => ({ range: { end: new vscodeStub.Position(n, 80) } }),
    },
    setDecorations: (decType, opts) => { setCalls[decType._id] = opts; },
    _setCalls: setCalls,
  };
}

let failed = 0;
function check(name, cond) {
  console.log((cond ? "  ok  " : " FAIL ") + name);
  if (!cond) failed++;
}

// === TEST 1: decoration mode emits pills, matched by exact path ==============
{
  const ed = fakeEditor(FILE);
  applyDecorations(ed, state, { mode: "decoration", thresholdWarn: 1024, thresholdCritical: 4096, pathsLimit: 5, pathsMaxDepth: 32 });
  const total = Object.values(ed._setCalls).reduce((a, arr) => a + (arr ? arr.length : 0), 0);
  check("decoration mode: emits 2 pills (app_main, worker)", total === 2);
  const allOpts = Object.values(ed._setCalls).flat().filter(Boolean);
  const hasAfter = allOpts.every(o => o.renderOptions && o.renderOptions.after && o.renderOptions.after.contentText);
  check("decoration: each pill has after-text", hasAfter && allOpts.length === 2);
  const hasHover = allOpts.every(o => o.hoverMessage);
  check("decoration: each pill carries a hoverMessage", hasHover);
}

// === TEST 2: path with BACKSLASHES still matches (normPath) ===================
{
  const winPath = "\\tmp\\ws\\app\\app.c"; // same file, Windows-style separators
  const ed = fakeEditor(winPath);
  applyDecorations(ed, state, { mode: "decoration", thresholdWarn: 1024, thresholdCritical: 4096, pathsLimit: 5, pathsMaxDepth: 32 });
  const total = Object.values(ed._setCalls).reduce((a, arr) => a + (arr ? arr.length : 0), 0);
  // On non-Windows, backslash normalization to "/" still yields "/tmp/ws/app/app.c".
  check("backslash path normalizes & matches (2 pills)", total === 2);
}

// === TEST 3: hover mode CLEARS decorations ===================================
{
  const ed = fakeEditor(FILE);
  applyDecorations(ed, state, { mode: "hover", thresholdWarn: 1024, thresholdCritical: 4096, pathsLimit: 5, pathsMaxDepth: 32 });
  const total = Object.values(ed._setCalls).reduce((a, arr) => a + (arr ? arr.length : 0), 0);
  check("hover mode: decorations cleared (0 pills)", total === 0);
}

// === TEST 4: hover provider returns markdown in hover mode ===================
{
  const provider = makeHoverProvider(() => state, () => ({ mode: "hover", thresholdWarn: 1024, thresholdCritical: 4096, pathsLimit: 5, pathsMaxDepth: 32 }));
  const doc = {
    uri: { fsPath: FILE },
    getWordRangeAtPosition: (pos) => ({ start: pos, end: pos }),
    getText: () => "app_main",
  };
  const hover = provider.provideHover(doc, { line: 8, character: 4 });
  const text = hover && hover.contents && hover.contents[0] ? hover.contents[0].value : "";
  check("hover mode: returns markdown for app_main", !!hover && /app_main/.test(text));
  check("hover mode: markdown is non-trivial (>100 chars)", text.length > 100);
}

// === TEST 5: hover does NOT fire in decoration mode ==========================
{
  const provider = makeHoverProvider(() => state, () => ({ mode: "decoration", thresholdWarn: 1024, thresholdCritical: 4096, pathsLimit: 5, pathsMaxDepth: 32 }));
  const doc = { uri: { fsPath: FILE }, getWordRangeAtPosition: (p) => ({ start: p, end: p }), getText: () => "app_main" };
  const hover = provider.provideHover(doc, { line: 8, character: 4 });
  check("decoration mode: hover provider returns nothing", hover === undefined);
}

// === TEST 6: hover fires only on the DEFINITION line =========================
{
  const provider = makeHoverProvider(() => state, () => ({ mode: "hover", thresholdWarn: 1024, thresholdCritical: 4096, pathsLimit: 5, pathsMaxDepth: 32 }));
  const doc = { uri: { fsPath: FILE }, getWordRangeAtPosition: (p) => ({ start: p, end: p }), getText: () => "app_main" };
  // Cursor on "app_main" token but at a DIFFERENT line (a call site, not the def).
  const hover = provider.provideHover(doc, { line: 50, character: 4 });
  check("hover: no hover on a non-definition line", hover === undefined);
}

// === TEST 7: UNBOUND fp (estimated, not bound) — hover wording + pill mark ===
{
  // A dispatcher with one fp site, candidates inferred but NO override.
  const FILE2 = "/tmp/ws/drv.c";
  const recDisp = { name: "dispatch", file: FILE2, nameLine: 5, nameCol: 4,
    stackBytes: 32, stackQualifier: "", callees: ["h_a", "h_b"], indirectCallees: ["h_a", "h_b"], ghost: false };
  const recA = { name: "h_a", file: FILE2, nameLine: 1, nameCol: 4, stackBytes: 64, callees: [], indirectCallees: [], ghost: false };
  const recB = { name: "h_b", file: FILE2, nameLine: 2, nameCol: 4, stackBytes: 256, callees: [], indirectCallees: [], ghost: false };
  const depth2 = new Map([
    ["dispatch", { depth: 1, recursive: false, cumulativeStack: 288, fpVerified: false,
                   fpSites: [{ line: 5, via: "tbl", candidates: ["h_a", "h_b"], overridden: false }],
                   perRoot: [{ rootName: "dispatch", depth: 1, cumulativeStack: 288, isAuto: false }] }],
    ["h_a", { depth: 2, recursive: false, cumulativeStack: 64, fpVerified: false, fpSites: [], perRoot: [] }],
    ["h_b", { depth: 2, recursive: false, cumulativeStack: 256, fpVerified: false, fpSites: [], perRoot: [] }],
  ]);
  const st2 = {
    byName: new Map([["dispatch", recDisp], ["h_a", recA], ["h_b", recB]]),
    byFile: new Map([[normPath(FILE2), [recDisp, recA, recB]]]),
    depth: depth2, pinnedRoots: new Set(["dispatch"]),
  };
  // Hover wording: must say "estimated, not bound".
  const provider = makeHoverProvider(() => st2, () => ({ mode: "hover", thresholdWarn: 1024, thresholdCritical: 4096, pathsLimit: 5, pathsMaxDepth: 32 }));
  const doc = { uri: { fsPath: FILE2 }, getWordRangeAtPosition: (p) => ({ start: p, end: p }), getText: () => "dispatch" };
  const hover = provider.provideHover(doc, { line: 5, character: 4 });
  const text = hover && hover.contents[0] ? hover.contents[0].value : "";
  check("unbound fp: hover says 'estimated, not bound'", /estimated, not bound/i.test(text));
  check("unbound fp: hover lists the inferred targets", /h_a/.test(text) && /h_b/.test(text));
  // Pill mark: must include the unbound fp marker '≀~'.
  const ed = fakeEditor(FILE2);
  applyDecorations(ed, st2, { mode: "decoration", thresholdWarn: 1024, thresholdCritical: 4096, pathsLimit: 5, pathsMaxDepth: 32 });
  const pillText = Object.values(ed._setCalls).flat().filter(Boolean)
    .map(o => o.renderOptions.after.contentText).join(" | ");
  check("unbound fp: pill shows '≀~' (estimated, not bound)", /≀~/.test(pillText));
}

// === TEST 8: BOUND fp (verified) — hover wording + pill mark ================
{
  const FILE3 = "/tmp/ws/drv2.c";
  const recDisp = { name: "disp2", file: FILE3, nameLine: 5, nameCol: 4,
    stackBytes: 32, stackQualifier: "", callees: ["only_h"], indirectCallees: ["only_h"], ghost: false };
  const recH = { name: "only_h", file: FILE3, nameLine: 1, nameCol: 4, stackBytes: 64, callees: [], indirectCallees: [], ghost: false };
  const depth3 = new Map([
    ["disp2", { depth: 1, recursive: false, cumulativeStack: 96, fpVerified: true,
                fpSites: [{ line: 5, via: "tbl", candidates: ["only_h"], overridden: true }],
                perRoot: [{ rootName: "disp2", depth: 1, cumulativeStack: 96, isAuto: false }] }],
    ["only_h", { depth: 2, recursive: false, cumulativeStack: 64, fpVerified: false, fpSites: [], perRoot: [] }],
  ]);
  const st3 = {
    byName: new Map([["disp2", recDisp], ["only_h", recH]]),
    byFile: new Map([[normPath(FILE3), [recDisp, recH]]]),
    depth: depth3, pinnedRoots: new Set(["disp2"]),
  };
  const provider = makeHoverProvider(() => st3, () => ({ mode: "hover", thresholdWarn: 1024, thresholdCritical: 4096, pathsLimit: 5, pathsMaxDepth: 32 }));
  const doc = { uri: { fsPath: FILE3 }, getWordRangeAtPosition: (p) => ({ start: p, end: p }), getText: () => "disp2" };
  const hover = provider.provideHover(doc, { line: 5, character: 4 });
  const text = hover && hover.contents[0] ? hover.contents[0].value : "";
  check("bound fp: hover says 'bound' (verified)", /bound/i.test(text) && !/estimated, not bound/i.test(text));
  const ed = fakeEditor(FILE3);
  applyDecorations(ed, st3, { mode: "decoration", thresholdWarn: 1024, thresholdCritical: 4096, pathsLimit: 5, pathsMaxDepth: 32 });
  const pillText = Object.values(ed._setCalls).flat().filter(Boolean)
    .map(o => o.renderOptions.after.contentText).join(" | ");
  check("bound fp: pill shows '≀✓' (verified)", /≀✓/.test(pillText));
}

// === TEST 9: UNRESOLVED fp (no candidates, not bound) — under-approx warning =
{
  const FILE4 = "/tmp/ws/cb.c";
  const recApply = { name: "apply", file: FILE4, nameLine: 3, nameCol: 4,
    stackBytes: 32, stackQualifier: "", callees: [], indirectCallees: [], ghost: false };
  const depth4 = new Map([
    ["apply", { depth: 1, recursive: false, cumulativeStack: 32, fpVerified: false,
                fpSites: [{ line: 3, via: "cb", candidates: [], overridden: false }],
                perRoot: [{ rootName: "apply", depth: 1, cumulativeStack: 32, isAuto: false }] }],
  ]);
  const st4 = {
    byName: new Map([["apply", recApply]]),
    byFile: new Map([[normPath(FILE4), [recApply]]]),
    depth: depth4, pinnedRoots: new Set(["apply"]),
  };
  const provider = makeHoverProvider(() => st4, () => ({ mode: "hover", thresholdWarn: 1024, thresholdCritical: 4096, pathsLimit: 5, pathsMaxDepth: 32 }));
  const doc = { uri: { fsPath: FILE4 }, getWordRangeAtPosition: (p) => ({ start: p, end: p }), getText: () => "apply" };
  const hover = provider.provideHover(doc, { line: 3, character: 4 });
  const text = hover && hover.contents[0] ? hover.contents[0].value : "";
  check("unresolved fp: hover warns 'unresolved, not bound'", /unresolved, not bound/i.test(text));
  check("unresolved fp: hover mentions under-approximation", /under-approximation/i.test(text));
}

// === TEST 10: hover & side-panel agree on root status / depth / peak ========
// The user's requirement: decoration/hover info must match the (correct) side
// panel. We drive BOTH the HoverProvider and SidePanelProvider.resolveQuery
// from the same state and assert they report the same root flags.
{
  // Three functions: a pinned root, an interior fn reached at depth 2, and an
  // auto (caller-less) root. Authoritative flags live on DepthInfo.
  const F = "/tmp/ws/r.c";
  const recRoot = { name: "rootfn", file: F, nameLine: 1, nameCol: 4, stackBytes: 32, stackQualifier: "", callees: ["mid"], indirectCallees: [], ghost: false };
  const recMid  = { name: "mid",    file: F, nameLine: 5, nameCol: 4, stackBytes: 64, stackQualifier: "", callees: [], indirectCallees: [], ghost: false };
  const recAuto = { name: "autofn", file: F, nameLine: 9, nameCol: 4, stackBytes: 16, stackQualifier: "", callees: [], indirectCallees: [], ghost: false };
  const dep = new Map([
    ["rootfn", { depth: 1, recursive: false, cumulativeStack: 96, isPinnedRoot: true, isAutoRoot: false, fpSites: [],
                 perRoot: [{ rootName: "rootfn", depth: 1, cumulativeStack: 96 }] }],
    ["mid",    { depth: 2, recursive: false, cumulativeStack: 64, isPinnedRoot: false, isAutoRoot: false, fpSites: [],
                 perRoot: [{ rootName: "rootfn", depth: 2, cumulativeStack: 64 }] }],
    ["autofn", { depth: 1, recursive: false, cumulativeStack: 16, isPinnedRoot: false, isAutoRoot: true, fpSites: [],
                 perRoot: [{ rootName: "autofn", depth: 1, cumulativeStack: 16 }] }],
  ]);
  const st = {
    byName: new Map([["rootfn", recRoot], ["mid", recMid], ["autofn", recAuto]]),
    byFile: new Map([[normPath(F), [recRoot, recMid, recAuto]]]),
    depth: dep, pinnedRoots: new Set(["rootfn"]),
    thresholdWarn: 1024, thresholdCritical: 4096, pathsLimit: 5, pathsMaxDepth: 32,
  };

  const hoverProvider = makeHoverProvider(() => st, () => ({ mode: "hover", thresholdWarn: 1024, thresholdCritical: 4096, pathsLimit: 5, pathsMaxDepth: 32 }));
  function hoverText(name, line) {
    const doc = { uri: { fsPath: F }, getWordRangeAtPosition: (p) => ({ start: p, end: p }), getText: () => name };
    const h = hoverProvider.provideHover(doc, { line, character: 4 });
    return h && h.contents[0] ? h.contents[0].value : "";
  }

  // Pinned root: hover must show "pinned root", NOT "auto root".
  const tRoot = hoverText("rootfn", 1);
  check("hover: pinned root shows '📌 pinned root'", /pinned root/.test(tRoot) && !/auto root/.test(tRoot));

  // Interior fn (depth 2, not a root): hover must NOT claim it's a root.
  // (Old heuristic `depth===1` was fine here, but an interior fn at depth 1
  //  from a root would have been mislabeled; the authoritative flag fixes that.)
  const tMid = hoverText("mid", 5);
  check("hover: interior fn is NOT labeled a root", !/pinned root/.test(tMid) && !/auto root/.test(tMid));

  // Auto root (caller-less): hover must show "auto root".
  const tAuto = hoverText("autofn", 9);
  check("hover: auto root shows '⚓ auto root'", /auto root/.test(tAuto) && !/pinned root/.test(tAuto));

  // Now the SidePanelProvider for the same functions — must AGREE.
  let SidePanelProvider;
  try { ({ SidePanelProvider } = require("../out/sidePanel.js")); } catch (e) {}
  if (SidePanelProvider) {
    const provider = new SidePanelProvider({ getState: () => st, onQuery: () => {}, log: { info(){}, warn(){}, error(){} } });
    const pRoot = provider.resolveQuery("rootfn");
    const pMid = provider.resolveQuery("mid");
    const pAuto = provider.resolveQuery("autofn");
    check("panel agrees: rootfn pinnedRoot=true", pRoot.pinnedRoot === true && pRoot.autoRoot === false);
    check("panel agrees: mid is interior (no root flags)", pMid.pinnedRoot === false && pMid.autoRoot === false);
    check("panel agrees: autofn autoRoot=true", pAuto.autoRoot === true && pAuto.pinnedRoot === false);
    // Depth + peak parity between panel payload and DepthInfo (single source).
    check("panel depth matches DepthInfo (mid=2)", pMid.depth === 2);
    check("panel peak matches DepthInfo (rootfn=96)", pRoot.cumulativeStack === 96);
  } else {
    check("SidePanelProvider loadable for parity check", false, "could not require sidePanel.js");
  }
}

// === TEST 11: hover & pill peak = function's OWN peak, not per-root ==========
{
  const F = "/tmp/ws/pk.c";
  const rec = { name: "pk", file: F, nameLine: 0, nameCol: 4, stackBytes: 128, stackQualifier: "", callees: [], indirectCallees: [], ghost: false };
  // info.cumulativeStack (own downward peak) = 512; per-root entry peaks differ.
  const dep = new Map([["pk", {
    depth: 3, recursive: false, cumulativeStack: 512, cumulativeBounded: false,
    isPinnedRoot: false, isAutoRoot: false, fpSites: [],
    perRoot: [{ rootName: "r1", depth: 3, cumulativeStack: 900 },
              { rootName: "r2", depth: 2, cumulativeStack: 700 }]
  }]]);
  const st = {
    byName: new Map([["pk", rec]]),
    byFile: new Map([[normPath(F), [rec]]]),
    depth: dep, pinnedRoots: new Set(),
  };
  const provider = makeHoverProvider(() => st, () => ({ mode: "hover", thresholdWarn: 1024, thresholdCritical: 4096, pathsLimit: 5, pathsMaxDepth: 32 }));
  const doc = { uri: { fsPath: F }, getWordRangeAtPosition: (p) => ({ start: p, end: p }), getText: () => "pk" };
  const text = provider.provideHover(doc, { line: 0, character: 4 }).contents[0].value;
  const m = text.match(/\*\*Peak:\*\* `([^`]+)`/);
  check("hover headline Peak = own peak (512B, not per-root 900)", !!m && /^512B/.test(m[1]));

  const ed = fakeEditor(F);
  applyDecorations(ed, st, { mode: "decoration", thresholdWarn: 1024, thresholdCritical: 4096, pathsLimit: 5, pathsMaxDepth: 32 });
  const pill = Object.values(ed._setCalls).flat().filter(Boolean).map(o => o.renderOptions.after.contentText).join(" | ");
  check("pill peak p:512B (own peak, not per-root 900)", /p:512B/.test(pill) && !/p:900/.test(pill));
}

console.log(failed === 0
  ? "\nDECORATION+HOVER: PASS — all checks passed."
  : `\nDECORATION+HOVER: FAIL — ${failed} check(s) failed.`);
process.exit(failed === 0 ? 0 : 1);
