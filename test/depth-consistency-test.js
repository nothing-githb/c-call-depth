// Verifies that the "Calls into" list, when sorted by hops, surfaces the same
// number as the Overview "Top by depth" (downDepth). The side panel injects the
// single deepest downward chain (longestPathFrom) into the outgoing paths so it
// survives pathsFrom's depth cap and stack-ranked limit. This guards the bug
// where the deepest (low-stack or very deep) chain was dropped, so hops-sort's
// top no longer matched the function's depth.
const path = require("path");
const { pathsFrom, longestPathFrom } = require(path.join(__dirname, "..", "out", "callGraph.js"));

let failed = 0;
function check(name, cond, extra) {
  console.log((cond ? "  ok  " : " FAIL ") + name + (cond ? "" : "  " + (extra || "")));
  if (!cond) failed++;
}

// Build a graph where:
//   F → H1/H2/H3   : short, HEAVY chains (2 nodes, 9000B leaves)
//   F → A → B → C → D : a deep, LIGHT chain (5 nodes, tiny frames)
// downDepth(F) = 5 (the deep chain), but it's the lowest-stack path.
const fr = (name, callees, stackBytes) => ({ name, file: name + ".c", nameLine: 0, nameCol: 0, callees, stackBytes });
const fns = new Map([
  ["F",  fr("F",  ["H1", "H2", "H3", "A"], 100)],
  ["H1", fr("H1", [], 9000)],
  ["H2", fr("H2", [], 9000)],
  ["H3", fr("H3", [], 9000)],
  ["A",  fr("A",  ["B"], 10)],
  ["B",  fr("B",  ["C"], 10)],
  ["C",  fr("C",  ["D"], 10)],
  ["D",  fr("D",  [], 10)],
]);

// Reference downDepth (1 + max child), the same recurrence the analyzer uses.
function downDepth(n, seen) {
  if (seen.has(n)) return 1;
  seen.add(n);
  let best = 0;
  for (const c of (fns.get(n)?.callees || [])) if (fns.has(c)) best = Math.max(best, downDepth(c, seen));
  seen.delete(n);
  return 1 + best;
}
const ddF = downDepth("F", new Set());
check("reference downDepth(F) is 5", ddF === 5, `got ${ddF}`);

// longestPathFrom returns the deepest chain; its hop count equals downDepth.
const deepest = longestPathFrom(fns, "F");
check("longestPathFrom hops == downDepth", deepest.nodes.length === ddF, `got ${deepest.nodes.length}`);
check("longestPathFrom is the deep chain F→A→B→C→D",
  deepest.nodes.join(">") === "F>A>B>C>D", deepest.nodes.join(">"));

// The bug: pathsFrom, ranked by stack with a small limit, DROPS the deep chain.
const raw = pathsFrom(fns, "F", 3, 20).filter(p => p.nodes.length > 1);
const rawMaxHops = Math.max(...raw.map(p => p.nodes.length));
check("pathsFrom (limit 3) omits the deepest chain (max hops 2, not 5)",
  rawMaxHops === 2, `rawMaxHops=${rawMaxHops}`);

// The fix: inject the deepest chain (mirrors SidePanelProvider.buildDetail) so
// sorting by hops surfaces downDepth.
function injectDeepest(out, dpst) {
  if (dpst.nodes.length > 1) {
    const key = dpst.nodes.join(" ");
    const idx = out.findIndex(p => p.nodes.join(" ") === key);
    if (idx > 0) out.splice(idx, 1);
    if (idx !== 0) out.unshift(dpst);
  }
  return out;
}
const injected = injectDeepest(raw.slice(), deepest);
const injMaxHops = Math.max(...injected.map(p => p.nodes.length));
check("after injection, max hops == downDepth (Overview ↔ Calls-into match)",
  injMaxHops === ddF, `injMaxHops=${injMaxHops}`);

// Depth cap: even with a tiny pathsMaxDepth, the injected deepest is uncapped.
const rawCapped = pathsFrom(fns, "F", 50, 2).filter(p => p.nodes.length > 1);
const cappedMax = Math.max(...rawCapped.map(p => p.nodes.length));
check("pathsFrom respects a small depth cap (≤ 3 nodes)", cappedMax <= 3, `cappedMax=${cappedMax}`);
const injectedCapped = injectDeepest(rawCapped.slice(), deepest);
check("injected deepest is NOT depth-capped (still 5 hops)",
  Math.max(...injectedCapped.map(p => p.nodes.length)) === ddF);

// A cycle must not hang and is marked bounded.
const cyc = new Map([
  ["X", fr("X", ["Y"], 10)],
  ["Y", fr("Y", ["X"], 10)],
]);
const lc = longestPathFrom(cyc, "X");
check("longestPathFrom terminates on a cycle and marks it bounded",
  lc.truncatedByCycle === true && lc.nodes.length >= 2);

// Depth-cap vs cycle labeling: a chain cut by the depth limit must be flagged
// truncatedByDepth (UI shows "…"), NEVER truncatedByCycle (which would show ↻).
const depthCut = pathsFrom(fns, "F", 50, 2).filter(p => p.nodes.length > 1);
check("depth-limited chain is flagged truncatedByDepth (not a cycle)",
  depthCut.some(p => p.truncatedByDepth === true && !p.truncatedByCycle));
check("no depth-cut chain is mislabeled as a cycle",
  depthCut.every(p => !(p.truncatedByDepth && p.truncatedByCycle)));
// A genuine cycle is flagged truncatedByCycle, and NOT truncatedByDepth.
const cycPaths = pathsFrom(cyc, "X", 10, 20);
check("a real cycle is flagged truncatedByCycle, not depth",
  cycPaths.some(p => p.truncatedByCycle === true && !p.truncatedByDepth));

console.log(failed === 0
  ? "\nDEPTH-CONSISTENCY: PASS — Calls-into hops-max matches Overview depth."
  : `\nDEPTH-CONSISTENCY: FAIL — ${failed} check(s) failed.`);
process.exit(failed === 0 ? 0 : 1);
