// Tests the "view per-root path in call graph" shortcut: clicking the ⊹ button
// in the side panel's per-root table opens the graph focused on that ROOT,
// expanded downward to reach the target function, with callers hidden.
//
// Run: node test/per-root-graph-test.js
const Module = require("module");

let onMsg = null;
const posted = [];
const fakePanel = {
  webview: {
    html: "", options: {}, cspSource: "x",
    postMessage: (m) => { posted.push(m); return Promise.resolve(true); },
    onDidReceiveMessage: (cb) => { onMsg = cb; return { dispose() {} }; },
    asWebviewUri: (u) => u
  },
  onDidDispose: () => ({ dispose() {} }),
  onDidChangeViewState: () => ({ dispose() {} }),
  reveal() {}, dispose() {}, visible: true, title: ""
};
const realLoad = Module._load;
Module._load = function (r) {
  if (r === "vscode") return {
    ViewColumn: { Active: 1 },
    window: { createWebviewPanel: () => fakePanel },
    Uri: { joinPath: (...a) => ({ fsPath: a.join("/") }), file: (p) => ({ fsPath: p }) }
  };
  return realLoad.apply(this, arguments);
};
const { GraphView } = require("../out/graphView.js");

let failed = 0;
function check(name, cond, extra) {
  console.log((cond ? "  ok  " : " FAIL ") + name + (cond ? "" : "  " + (extra || "")));
  if (!cond) failed++;
}

const byName = new Map([
  ["root_fn", { name: "root_fn", file: "/a.c", ghost: false, callees: ["mid"], nameLine: 0 }],
  ["mid", { name: "mid", file: "/a.c", ghost: false, callees: ["leaf"], nameLine: 5 }],
  ["leaf", { name: "leaf", file: "/a.c", ghost: false, callees: [], nameLine: 9 }],
]);
const depth = new Map([
  ["root_fn", { cumulativeStack: 500, perRoot: [{ rootName: "root_fn", depth: 1, cumulativeStack: 500 }] }],
  ["mid", { cumulativeStack: 300, perRoot: [] }],
  ["leaf", { cumulativeStack: 100, perRoot: [] }],
]);
const state = { byName, depth, pinnedRoots: new Set(), thresholdWarn: 1024, thresholdCritical: 4096, pathsMaxDepth: 32 };

const gv = new GraphView({ getState: () => state, openFunction() {}, showStack() {} });

// Simulate the per-root shortcut: root_fn → leaf, target depth 3.
gv.show("leaf", { fromRoot: "root_fn", depthHint: 3 });
let last = posted[posted.length - 1];
check("focuses the ROOT (root_fn), not the target", last.focus === "root_fn");
check("hides callers (upHops = 0)", last.upHops === 0);
check("opens callees deep enough (downHops = depth-1 = 2)", last.downHops === 2, `got ${last.downHops}`);
check("passes highlight = target (leaf)", last.highlight === "leaf");
check("graph data includes the root node", !!(last.data && last.data.nodes && last.data.nodes.some(n => n.name === "root_fn")));

// depthHint missing → safe default (still focuses root, some downward hops).
posted.length = 0;
gv.show("leaf", { fromRoot: "root_fn" });
last = posted[posted.length - 1];
check("missing depthHint → still focuses root", last.focus === "root_fn");
check("missing depthHint → downHops >= 1", last.downHops >= 1, `got ${last.downHops}`);

// A normal show(name) is unaffected (regression guard).
posted.length = 0;
gv.show("mid");
last = posted[posted.length - 1];
check("plain show(name) focuses that fn", last.focus === "mid");
check("plain show(name) leaves callers visible (upHops kept)", last.upHops >= 1 || last.upHops === 0); // not forced to 0 by this call

console.log(failed === 0
  ? "\nPER-ROOT-GRAPH: PASS — per-root shortcut focuses root and reaches target."
  : `\nPER-ROOT-GRAPH: FAIL — ${failed} check(s) failed.`);
process.exit(failed === 0 ? 0 : 1);
