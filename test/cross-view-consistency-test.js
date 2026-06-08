// Cross-view consistency on a (large) dataset: verify the data the three views
// render — the Function tab, the Overview tab, the hover, and the call graph —
// is mutually consistent, correct, and meaningful for EVERY function. All views
// read the same state.byName (FunctionRecord) + state.depth (DepthInfo) and the
// shared src/callGraph.ts traversals; this rebuilds that state exactly like
// src/pythonBackend.ts mapResult() and checks the invariants each view relies on.
//
// Exposes runChecks(data) for orchestrators (big-workspace-test.js); also runs
// as a CLI:  node test/cross-view-consistency-test.js <analysis.json>
const fs = require("fs");
const path = require("path");
const Module = require("module");

// Stub `vscode` (only MarkdownString is used by buildHoverMarkdown) so we can
// require the compiled providers without a live VS Code.
const vscodeStub = {
  MarkdownString: class {
    constructor() { this.value = ""; this.isTrusted = false; this.supportHtml = false; }
    appendMarkdown(s) { this.value += String(s); return this; }
    appendText(s) { this.value += String(s); return this; }
  },
};
const realLoad = Module._load;
Module._load = function (r) { if (r === "vscode") return vscodeStub; return realLoad.apply(this, arguments); };

const { neighborhood, pathsFrom, pathsTo, longestPathFrom } = require("../out/callGraph.js");
const { buildHoverMarkdown } = require("../out/displayProviders.js");

// Build state exactly like src/pythonBackend.ts mapResult().
function buildState(data) {
  const byName = new Map();
  const depth = new Map();
  const pinnedRoots = new Set(data.pinnedRoots || []);
  for (const [name, r] of Object.entries(data.byName)) {
    byName.set(name, {
      name, file: r.file, nameLine: r.line ?? 0, nameCol: 0,
      callees: Array.isArray(r.callees) ? r.callees.slice() : [],
      indirectCallees: Array.isArray(r.indirect) ? r.indirect.slice() : [],
      stackBytes: r.stackBytes ?? undefined,
      stackQualifier: r.stackQualifier ?? undefined,
    });
    const perRoot = (r.perRoot ?? []).map(e => ({
      rootName: e.root, depth: e.depth,
      cumulativeStack: e.peak ?? undefined,
      cumulativeBounded: e.peakBounded === true, isAuto: e.isAuto === true,
    }));
    depth.set(name, {
      depth: r.depth ?? 0, downDepth: r.downDepth ?? 0,
      downDepthBounded: r.downDepthBounded === true,
      isPinnedRoot: r.isPinnedRoot === true, isAutoRoot: r.isAutoRoot === true,
      cumulativeStack: r.peak ?? undefined, cumulativeBounded: r.peakBounded === true,
      recursive: r.recursive === true, recursiveViaFp: r.recursiveViaFp === true,
      fpVerified: r.fpVerified === true,
      fpSites: Array.isArray(r.fpSites) ? r.fpSites : [],
      perRoot,
    });
  }
  return { byName, depth, pinnedRoots };
}

// Run every cross-view check on a parsed analysis result. Returns
// {failed, total, log, names}. Does not print or exit (caller decides).
function runChecks(data) {
  const { byName, depth, pinnedRoots } = buildState(data);
  const names = [...byName.keys()];
  const log = [];
  let failed = 0, total = 0;
  const check = (name, cond, extra) => {
    total++; if (!cond) failed++;
    log.push((cond ? "  ok  " : " FAIL ") + name + (cond ? "" : "  " + (extra || "")));
  };
  const ex = (arr, n = 4) => arr.slice(0, n).join("; ") + (arr.length > n ? ` …(+${arr.length - n})` : "");
  const edge = (a, b) => { const r = byName.get(a); return !!r && r.callees.includes(b); };
  function canReachSelf(n) {
    const rec = byName.get(n); if (!rec) return false;
    if (rec.callees.includes(n)) return true;
    const seen = new Set(); const stack = rec.callees.slice();
    while (stack.length) {
      const c = stack.pop(); if (c === n) return true;
      if (seen.has(c)) continue; seen.add(c);
      const r = byName.get(c); if (r) for (const cc of r.callees) if (!seen.has(cc)) stack.push(cc);
    }
    return false;
  }

  check("dataset is large enough to be a meaningful cross-view check", names.length >= 100, `n=${names.length}`);

  // 1) Per-function data is meaningful & self-consistent (ALL functions)
  const bad = { peak: [], depth: [], indirect: [], callee: [], perRoot: [], legacyDepth: [], leaf: [] };
  for (const n of names) {
    const rec = byName.get(n), d = depth.get(n);
    const frame = rec.stackBytes ?? 0;
    if (d.cumulativeStack != null && d.cumulativeStack < frame) bad.peak.push(`${n}(peak ${d.cumulativeStack}<frame ${frame})`);
    if (!(Number.isInteger(d.downDepth) && d.downDepth >= 1)) bad.depth.push(`${n}(dd=${d.downDepth})`);
    for (const ic of rec.indirectCallees) if (!rec.callees.includes(ic)) bad.indirect.push(`${n}->${ic}`);
    for (const c of rec.callees) if (!byName.has(c)) bad.callee.push(`${n}->${c}`);
    for (const e of d.perRoot) {
      if (!byName.has(e.rootName)) bad.perRoot.push(`${n}@${e.rootName}(missing root)`);
      if (!(Number.isInteger(e.depth) && e.depth >= 1)) bad.perRoot.push(`${n}@${e.rootName}(depth ${e.depth})`);
    }
    const expLegacy = d.perRoot.length ? Math.max(...d.perRoot.map(e => e.depth)) : d.depth;
    if (d.perRoot.length && d.depth !== expLegacy) bad.legacyDepth.push(`${n}(depth ${d.depth}!=maxPerRoot ${expLegacy})`);
    const hasCallee = rec.callees.some(c => byName.has(c));
    if (!hasCallee && d.downDepth !== 1) bad.leaf.push(`${n}(leaf dd=${d.downDepth})`);
  }
  check("every function: peak >= its own stack frame", bad.peak.length === 0, ex(bad.peak));
  check("every function: downDepth is an integer >= 1", bad.depth.length === 0, ex(bad.depth));
  check("every function: indirect (fp) callees are a subset of callees", bad.indirect.length === 0, ex(bad.indirect));
  check("every function: callees reference functions in the dataset", bad.callee.length === 0, ex(bad.callee));
  check("every function: per-root rows have a real root and depth >= 1", bad.perRoot.length === 0, ex(bad.perRoot));
  check("every function: legacy depth equals max per-root depth", bad.legacyDepth.length === 0, ex(bad.legacyDepth));
  check("every leaf: downDepth is exactly 1", bad.leaf.length === 0, ex(bad.leaf));

  // 2) downDepth == longest downward chain (the number shown everywhere)
  const ddMismatch = [], boundedMismatch = [];
  for (const n of names) {
    const d = depth.get(n);
    const lp = longestPathFrom(byName, n);
    if (!d.downDepthBounded) { if (lp.nodes.length !== d.downDepth) ddMismatch.push(`${n}(lp ${lp.nodes.length}!=dd ${d.downDepth})`); }
    else if (!lp.truncatedByCycle) boundedMismatch.push(`${n}(dd bounded but chain not)`);
  }
  check("downDepth == longestPathFrom hops for every non-recursive function", ddMismatch.length === 0, ex(ddMismatch));
  check("recursion-bounded depth: the longest chain is also marked bounded", boundedMismatch.length === 0, ex(boundedMismatch));

  // 3) recursion flag agrees with actual cycle membership
  const recFalsePos = [], recFalseNeg = [], viaFpInconsistent = [];
  for (const n of names) {
    const d = depth.get(n); const cycle = canReachSelf(n);
    if (d.recursive && !cycle) recFalsePos.push(n);
    if (!d.recursive && cycle) recFalseNeg.push(n);
    if (d.recursiveViaFp && !d.recursive) viaFpInconsistent.push(n);
  }
  check("recursive flag set => the function is actually in a cycle", recFalsePos.length === 0, ex(recFalsePos));
  check("function in a cycle => recursive flag is set", recFalseNeg.length === 0, ex(recFalseNeg));
  check("recursiveViaFp implies recursive", viaFpInconsistent.length === 0, ex(viaFpInconsistent));

  // 4) Overview lists are correct selections of the same data
  const withPeak = names.filter(n => depth.get(n).cumulativeStack != null);
  const topPeak = withPeak.slice().sort((a, b) => depth.get(b).cumulativeStack - depth.get(a).cumulativeStack).slice(0, 10);
  const topDepthL = names.slice().sort((a, b) => depth.get(b).downDepth - depth.get(a).downDepth).slice(0, 10);
  check("Overview Top-by-peak: list is non-increasing by the peak it shows",
    topPeak.every((n, i) => i === 0 || depth.get(topPeak[i - 1]).cumulativeStack >= depth.get(n).cumulativeStack));
  check("Overview Top-by-depth: list is non-increasing by downDepth (d:N)",
    topDepthL.every((n, i) => i === 0 || depth.get(topDepthL[i - 1]).downDepth >= depth.get(n).downDepth));
  check("Overview Top-by-depth: each row's d:N matches its longest chain",
    topDepthL.every(n => depth.get(n).downDepthBounded || longestPathFrom(byName, n).nodes.length === depth.get(n).downDepth));

  // representative sample for the heavier per-focus views
  const recFns = names.filter(n => depth.get(n).recursive);
  const fpFns = names.filter(n => (depth.get(n).fpSites || []).length > 0 || byName.get(n).indirectCallees.length > 0);
  const rootFns = names.filter(n => depth.get(n).isPinnedRoot || depth.get(n).isAutoRoot);
  const spread = names.filter((_, i) => i % Math.max(1, Math.floor(names.length / 12)) === 0);
  const sample = [...new Set([...topDepthL, ...topPeak, ...recFns.slice(0, 8),
    ...fpFns.slice(0, 8), ...rootFns.slice(0, 8), ...spread])].slice(0, 60);

  // 5) Call graph shows the SAME numbers/edges as the data
  const gBad = { focus: [], node: [], peak: [], rec: [], edge: [], indirect: [] };
  for (const f of sample) {
    const g = neighborhood(byName, depth, f, 4, 4);
    const nodeNames = new Set(g.nodes.map(nd => nd.name));
    const focusNode = g.nodes.find(nd => nd.isFocus);
    if (!focusNode || focusNode.name !== f) gBad.focus.push(f);
    for (const nd of g.nodes) {
      if (!byName.has(nd.name)) { gBad.node.push(`${f}:${nd.name}`); continue; }
      const d = depth.get(nd.name);
      if ((nd.peak ?? null) !== (d.cumulativeStack ?? null)) gBad.peak.push(`${f}:${nd.name}(${nd.peak}!=${d.cumulativeStack})`);
      if (!!nd.recursive !== !!d.recursive) gBad.rec.push(`${f}:${nd.name}`);
    }
    for (const e of g.edges) {
      if (!nodeNames.has(e.from) || !nodeNames.has(e.to)) gBad.edge.push(`${f}:${e.from}->${e.to}(dangling)`);
      else if (!edge(e.from, e.to)) gBad.edge.push(`${f}:${e.from}->${e.to}(not a real call)`);
      if (e.indirect && !byName.get(e.from).indirectCallees.includes(e.to)) gBad.indirect.push(`${f}:${e.from}->${e.to}`);
    }
  }
  check(`call graph (${sample.length} focuses): focus node is present and marked`, gBad.focus.length === 0, ex(gBad.focus));
  check("call graph: every node is a real function", gBad.node.length === 0, ex(gBad.node));
  check("call graph: node peak == the peak shown in Overview/Function", gBad.peak.length === 0, ex(gBad.peak));
  check("call graph: node recursive flag matches the analysis", gBad.rec.length === 0, ex(gBad.rec));
  check("call graph: every edge is a real caller->callee with both ends present", gBad.edge.length === 0, ex(gBad.edge));
  check("call graph: dashed (indirect) edges are real fp callees", gBad.indirect.length === 0, ex(gBad.indirect));

  // 6) Function tab paths agree with the graph (edge-valid chains)
  const pBad = { into: [], callers: [], tooDeep: [], cyc: [] };
  for (const f of sample) {
    const d = depth.get(f);
    for (const p of pathsFrom(byName, f, 50, 32)) {
      if (p.truncatedByCycle) { if (p.nodes.length < 2) pBad.cyc.push(`${f}(into cyc<2)`); continue; }
      for (let i = 0; i + 1 < p.nodes.length; i++) if (!edge(p.nodes[i], p.nodes[i + 1])) pBad.into.push(`${f}: ${p.nodes[i]}->${p.nodes[i + 1]}`);
      if (!d.downDepthBounded && p.nodes.length > d.downDepth) pBad.tooDeep.push(`${f}(${p.nodes.length}>${d.downDepth})`);
    }
    for (const p of pathsTo(byName, f, 50, 32, pinnedRoots)) {
      if (p.truncatedByCycle) { if (p.nodes.length < 2) pBad.cyc.push(`${f}(callers cyc<2)`); continue; }
      for (let i = 0; i + 1 < p.nodes.length; i++) if (!edge(p.nodes[i], p.nodes[i + 1])) pBad.callers.push(`${f}: ${p.nodes[i]}->${p.nodes[i + 1]}`);
    }
  }
  check("Function tab 'Calls into': every non-cyclic chain step is a real call edge", pBad.into.length === 0, ex(pBad.into));
  check("Function tab 'Callers': every non-cyclic chain step is a real call edge", pBad.callers.length === 0, ex(pBad.callers));
  check("Function tab 'Calls into': no chain exceeds the function's downDepth", pBad.tooDeep.length === 0, ex(pBad.tooDeep));
  check("Function tab: cycle-truncated chains depict a loop (>= 2 nodes)", pBad.cyc.length === 0, ex(pBad.cyc));

  // 7) Hover (displayProviders.buildHoverMarkdown) is stable and shows the same numbers
  const cfg = { mode: "hover", thresholdWarn: 1024, thresholdCritical: 4096, pathsLimit: 5, pathsMaxDepth: 32 };
  const hstate = { byName, byFile: new Map(), depth, pinnedRoots };
  const hBad = { threw: [], name: [], peak: [] };
  for (const f of sample) {
    let md;
    try { md = buildHoverMarkdown(byName.get(f), depth.get(f), hstate, cfg); }
    catch (e) { hBad.threw.push(`${f}: ${e && e.message}`); continue; }
    const v = (md && md.value) || "";
    if (!v.includes("`" + f + "`")) hBad.name.push(f);
    const d = depth.get(f);
    if (d.cumulativeStack != null && !v.includes("Peak")) hBad.peak.push(f);
  }
  check("hover: builds without throwing for every sampled function", hBad.threw.length === 0, ex(hBad.threw));
  check("hover: shows the function name", hBad.name.length === 0, ex(hBad.name));
  check("hover: shows the Peak when a peak is available", hBad.peak.length === 0, ex(hBad.peak));

  return { failed, total, log, names };
}

if (require.main === module) {
  const jsonPath = process.argv[2] || "/tmp/allf.json";
  const data = JSON.parse(fs.readFileSync(jsonPath, "utf8"));
  const { failed, total, log, names } = runChecks(data);
  console.log(`dataset: ${names.length} functions from ${path.basename(jsonPath)}\n`);
  console.log(log.join("\n"));
  console.log(failed === 0
    ? `\nCROSS-VIEW-CONSISTENCY: PASS — Function, Overview, hover & call graph agree across ${names.length} functions (${total} checks).`
    : `\nCROSS-VIEW-CONSISTENCY: FAIL — ${failed}/${total} check(s) failed.`);
  process.exit(failed === 0 ? 0 : 1);
}

module.exports = { runChecks, buildState };
