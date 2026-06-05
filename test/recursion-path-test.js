// Verifies that whenever a function is flagged recursive (↻), the side panel
// shows SOMETHING about the recursion — either the explicit loop path(s) or, if
// the loop can't be enumerated, an explanatory note. The ↻ marker is never left
// silently unexplained.
//
// Covers:
//   - normal short cycle: explicit path shown
//   - long cycle (was lost at the old depthCap=16): now found within the bound
//   - recursive flag but no concrete edge (fp over-approx): explanatory note
//
// Run: node test/recursion-path-test.js
const Module = require("module");
const realLoad = Module._load;
Module._load = function (r) {
  if (r === "vscode") return {
    EventEmitter: class { constructor() { this.event = () => ({ dispose() {} }); } fire() {} },
    Uri: { file: (p) => ({ fsPath: p }), joinPath: (...a) => ({ fsPath: a.join("/") }) },
    window: {}, workspace: { getConfiguration: () => ({ get: (k, d) => d }) }
  };
  return realLoad.apply(this, arguments);
};
const { SidePanelProvider } = require("../out/sidePanel.js");

let failed = 0;
function check(name, cond, extra) {
  console.log((cond ? "  ok  " : " FAIL ") + name + (cond ? "" : "  " + (extra || "")));
  if (!cond) failed++;
}
function mk(byName, depth, n, callees, recursive, viaFp) {
  byName.set(n, { name: n, file: "a.c", nameLine: 1, nameCol: 0, callees, stackBytes: 32, indirectCallees: viaFp ? callees : [] });
  depth.set(n, { name: n, file: "a.c", line: 1, callees, recursive, recursiveViaFp: !!viaFp, perRoot: [], depth: 1, cumulativeStack: 100 });
}
function provider(byName, depth) {
  const state = { byName, depth, pinnedRoots: new Set(), thresholdWarn: 1024, thresholdCritical: 4096, pathsMaxDepth: 160 };
  return new SidePanelProvider({ getState: () => state, onQuery: () => {}, log: { info() {}, warn() {}, error() {} } });
}

// 1) Short direct self-recursion → explicit path.
{
  const byName = new Map(), depth = new Map();
  mk(byName, depth, "self", ["self"], true, false);
  const dto = provider(byName, depth).resolveQuery("self");
  check("short self-recursion: explicit cycle path shown", dto.recursive && dto.cycles.length >= 1,
        `cycles=${dto.cycles.length}`);
}

// 2) Long 20-hop cycle (lost at old depthCap=16) → now found.
{
  const byName = new Map(), depth = new Map();
  const N = 20;
  for (let i = 0; i < N; i++) mk(byName, depth, "L" + i, ["L" + ((i + 1) % N)], true, false);
  const dto = provider(byName, depth).resolveQuery("L0");
  check("long 20-hop cycle: path is found (depth cap raised)", dto.recursive && dto.cycles.length >= 1,
        `cycles=${dto.cycles.length}`);
}

// 3) Recursive flag but no concrete loop edge (fp over-approx) → no path, but
//    the DTO must signal recursive so the UI can show an explanatory note.
{
  const byName = new Map(), depth = new Map();
  mk(byName, depth, "orphan", [], true, true);
  const dto = provider(byName, depth).resolveQuery("orphan");
  check("fp-only recursive w/o edge: still flagged recursive", dto.recursive === true);
  check("fp-only recursive w/o edge: cycles empty (honest)", dto.cycles.length === 0);
  check("fp-only recursive w/o edge: marked via fp (drives the note)", dto.recursiveViaFp === true);
  check("fp-only recursive w/o edge: not falsely truncated", dto.cyclesTruncated === false);
}

// 4) Mutual recursion A<->B → both directions enumerable from A.
{
  const byName = new Map(), depth = new Map();
  mk(byName, depth, "A", ["B"], true, false);
  mk(byName, depth, "B", ["A"], true, false);
  const dto = provider(byName, depth).resolveQuery("A");
  check("mutual recursion: path A→B→A shown",
        dto.cycles.length >= 1 && dto.cycles[0].nodes.length >= 3,
        `cycles=${dto.cycles.length}`);
}

// 5) Very long cycle (longer than the depth cap) → shortest-cycle fallback
//    still returns one concrete path (no "couldn't show" for a real loop).
{
  const byName = new Map(), depth = new Map();
  const N = 100;
  for (let i = 0; i < N; i++) mk(byName, depth, "L" + i, ["L" + ((i + 1) % N)], true, false);
  const dto = provider(byName, depth).resolveQuery("L0");
  check("100-hop cycle: a concrete path is still shown (BFS fallback)",
        dto.cycles.length >= 1 && dto.cycles[0].nodes.length === N + 1,
        `cycles=${dto.cycles.length}, len=${dto.cycles[0] && dto.cycles[0].nodes.length}`);
}

// 6) Dense clique (combinatorially many cycles) → enumeration hits a limit but
//    at least one path is always present; UI shows "subset", not an apology.
{
  const byName = new Map(), depth = new Map();
  const N = 12, all = [];
  for (let i = 0; i < N; i++) all.push("K" + i);
  for (let i = 0; i < N; i++) mk(byName, depth, "K" + i, all.filter(x => x !== "K" + i), true, false);
  const dto = provider(byName, depth).resolveQuery("K0");
  check("dense clique: at least one path shown despite hitting a limit",
        dto.cycles.length >= 1, `cycles=${dto.cycles.length}`);
  check("dense clique: truncation is reported with a reason",
        dto.cyclesTruncated === true && !!dto.cyclesLimitHit, `limitHit=${dto.cyclesLimitHit}`);
}

// 7) Recursion only via fp over-approx with NO real edge → honestly no path,
//    but still flagged so the UI explains it.
{
  const byName = new Map(), depth = new Map();
  mk(byName, depth, "fponly", [], true, true);
  const dto = provider(byName, depth).resolveQuery("fponly");
  check("fp-only with no real edge: no path, still flagged recursive",
        dto.recursive === true && dto.cycles.length === 0 && dto.recursiveViaFp === true);
}

// 8) OPTIONAL: if a real analysis JSON is given (with the big-workspace's
//    100-hop long cycle), verify the shortest-cycle BFS reconstructs the full
//    lc_00 → … → lc_99 → lc_00 loop on actual data, not just synthetic input.
const realJson = process.argv[2];
if (realJson) {
  try {
    const data = JSON.parse(require("fs").readFileSync(realJson, "utf8"));
    if (data.byName && data.byName["lc_00"]) {
      const byName = new Map(), depth = new Map();
      for (const [n, r] of Object.entries(data.byName)) {
        byName.set(n, { name: n, file: r.file, nameLine: r.line || 0, nameCol: 0,
                        callees: r.callees || [], stackBytes: r.stackBytes,
                        indirectCallees: r.indirect || [] });
        depth.set(n, r);
      }
      const dto = provider(byName, depth).resolveQuery("lc_00");
      check("real 100-hop cycle: a path is reconstructed",
            dto.cycles.length >= 1, `cycles=${dto.cycles.length}`);
      const c = dto.cycles[0];
      check("real 100-hop cycle: full loop lc_00 → … → lc_00 (101 nodes)",
            c && c.nodes.length === 101 && c.nodes[0] === "lc_00" &&
            c.nodes[c.nodes.length - 1] === "lc_00",
            c ? `len=${c.nodes.length}` : "no cycle");
    } else {
      console.log("  ..  (real-analysis 100-hop check skipped: lc_00 not in JSON)");
    }
  } catch (e) {
    console.log("  ..  (real-analysis 100-hop check skipped: " + e.message + ")");
  }
}

console.log(failed === 0
  ? "\nRECURSION-PATH: PASS — recursion is always shown (path or explanatory note)."
  : `\nRECURSION-PATH: FAIL — ${failed} check(s) failed.`);
process.exit(failed === 0 ? 0 : 1);
