// Edge readability test: for a variety of graph topologies, asserts that no
// edge path passes THROUGH a node's body box (which would hide the line).
// Reproduces the rec_ping_07 ↔ rec_pong_07 mutual-recursion case (a backward
// edge that used to cut straight through the focused node) and generalizes it.
//
// Method: render the real GRAPH_HTML in jsdom, read each node's on-screen box
// from its <g transform="translate(x,y)">, sample points along every edge's
// cubic path, and check that no sample (except near the edge's own endpoints)
// lands inside a node body rectangle.
//
// Run: NODE_PATH=/tmp/jsdomtest/node_modules node test/edge-over-node-test.js
const { JSDOM } = require("jsdom");
const fs = require("fs");
const path = require("path");
const Module = require("module");
const realLoad = Module._load;
Module._load = function (r) { if (r === "vscode") return {}; return realLoad.apply(this, arguments); };
const { GRAPH_HTML } = require(path.join(__dirname, "..", "out", "graphView.js"));

let failed = 0;
function check(name, cond, extra) {
  console.log((cond ? "  ok  " : " FAIL ") + name + (cond ? "" : "  " + (extra || "")));
  if (!cond) failed++;
}

// Node body size as drawn by the view.
const NODE_W = 200, NODE_H = 38;

// Cubic Bézier point at parameter t.
function cubic(p0, p1, p2, p3, t) {
  const u = 1 - t;
  const x = u*u*u*p0[0] + 3*u*u*t*p1[0] + 3*u*t*t*p2[0] + t*t*t*p3[0];
  const y = u*u*u*p0[1] + 3*u*u*t*p1[1] + 3*u*t*t*p2[1] + t*t*t*p3[1];
  return [x, y];
}
// Parse "M x,y C x1,y1 x2,y2 x3,y3" → control points (first subpath only).
function parsePath(d) {
  const nums = d.match(/-?\d+(?:\.\d+)?/g);
  if (!nums || nums.length < 8) return null;
  const n = nums.map(Number);
  return [[n[0], n[1]], [n[2], n[3]], [n[4], n[5]], [n[6], n[7]]];
}

function render(graph) {
  const dom = new JSDOM(`<!DOCTYPE html><html><body>${GRAPH_HTML.match(/<body>([\s\S]*?)<\/body>/i)[1]}</body></html>`,
    { runScripts: "outside-only", pretendToBeVisual: true });
  const w = dom.window;
  w.acquireVsCodeApi = () => ({ postMessage() {}, getState: () => ({}), setState() {} });
  if (w.SVGElement) w.SVGElement.prototype.getBBox = () => ({ x: 0, y: 0, width: 100, height: 100 });
  try { Object.defineProperty(w.document, "readyState", { value: "complete", configurable: true }); } catch (_) {}
  new w.Function(GRAPH_HTML.match(/<script>([\s\S]*?)<\/script>/)[1]).call(w);
  w.dispatchEvent(new w.MessageEvent("message", { data: {
    type: "graph", focus: graph.focus, thresholds: { warn: 1024, critical: 4096 },
    names: graph.nodes.map(n => n.name), data: graph
  } }));
  return w;
}

// Read node body boxes keyed by name (label text minus marker glyphs).
function nodeBoxes(w) {
  const boxes = {};
  for (const g of w.document.querySelectorAll("g[transform]")) {
    const m = (g.getAttribute("transform") || "").match(/translate\(([-\d.]+),\s*([-\d.]+)\)/);
    const lbl = g.querySelector(".node-label");
    if (!m || !lbl) continue;
    const name = lbl.textContent.replace(/[↻⚓📌≀✓~?\s]+/g, " ").trim().split(" ").pop();
    boxes[name] = { x: +m[1], y: +m[2], w: NODE_W, h: NODE_H };
  }
  return boxes;
}

function pointInBox(px, py, b, pad) {
  return px > b.x + pad && px < b.x + b.w - pad &&
         py > b.y + pad && py < b.y + b.h - pad;
}

// For one rendered graph, check every edge path against every node body.
function assertNoEdgeThroughNode(label, w, focusName) {
  const boxes = nodeBoxes(w);
  const edges = Array.from(w.document.querySelectorAll(".edge"));
  let crossings = 0;
  let detail = "";
  for (const e of edges) {
    const cps = parsePath(e.getAttribute("d") || "");
    if (!cps) continue;
    const [p0, p1, p2, p3] = cps;
    // Endpoint node names aren't on the path element; instead we simply skip
    // samples that sit within a small radius of the path's own endpoints, so a
    // curve legitimately touching its source/target node edge isn't flagged.
    for (let i = 1; i < 16; i++) {
      const t = i / 16;
      const [x, y] = cubic(p0, p1, p2, p3, t);
      // skip near endpoints (where the curve meets its own nodes)
      const nearStart = Math.hypot(x - p0[0], y - p0[1]) < 24;
      const nearEnd = Math.hypot(x - p3[0], y - p3[1]) < 24;
      if (nearStart || nearEnd) continue;
      for (const name in boxes) {
        if (pointInBox(x, y, boxes[name], 4)) {
          crossings++;
          if (!detail) detail = `edge sample (${x.toFixed(0)},${y.toFixed(0)}) inside ${name}`;
        }
      }
    }
  }
  check(`${label}: no edge passes through a node body`, crossings === 0, detail);
}

// ── Topologies ────────────────────────────────────────────────────────────

// 1) Mutual recursion A↔B (the reported rec_ping_07 / rec_pong_07 case).
assertNoEdgeThroughNode("mutual recursion A↔B", render({
  focus: "A",
  nodes: [
    { name: "A", isFocus: true, stackBytes: 32, peak: 64, recursive: true, layer: 0 },
    { name: "B", stackBytes: 32, peak: 64, recursive: true, layer: 1 }
  ],
  edges: [
    { from: "A", to: "B", recursive: true, offFocus: false },
    { from: "B", to: "A", recursive: true, offFocus: true }
  ]
}), "A");

// 2) Three-node cycle A→B→C→A (backward closing edge spans two layers).
assertNoEdgeThroughNode("three-node cycle A→B→C→A", render({
  focus: "A",
  nodes: [
    { name: "A", isFocus: true, stackBytes: 32, peak: 96, recursive: true, layer: 0 },
    { name: "B", stackBytes: 32, peak: 96, recursive: true, layer: 1 },
    { name: "C", stackBytes: 32, peak: 96, recursive: true, layer: 2 }
  ],
  edges: [
    { from: "A", to: "B", recursive: true, offFocus: false },
    { from: "B", to: "C", recursive: true, offFocus: false },
    { from: "C", to: "A", recursive: true, offFocus: true }
  ]
}), "A");

// 3) Skip-layer forward edge A→C while B sits between them on a middle layer.
assertNoEdgeThroughNode("skip-layer edge A→C over B", render({
  focus: "A",
  nodes: [
    { name: "A", isFocus: true, stackBytes: 32, peak: 96, layer: 0 },
    { name: "B", stackBytes: 32, peak: 64, layer: 1 },
    { name: "C", stackBytes: 32, peak: 32, layer: 2 }
  ],
  edges: [
    { from: "A", to: "B", offFocus: false },
    { from: "B", to: "C", offFocus: false },
    { from: "A", to: "C", offFocus: false }
  ]
}), "A");

// 4) Fan-out: one parent to several children on the same next layer.
assertNoEdgeThroughNode("fan-out to siblings", render({
  focus: "P",
  nodes: [
    { name: "P", isFocus: true, stackBytes: 32, peak: 64, layer: 0 },
    { name: "C1", stackBytes: 16, peak: 16, layer: 1 },
    { name: "C2", stackBytes: 16, peak: 16, layer: 1 },
    { name: "C3", stackBytes: 16, peak: 16, layer: 1 }
  ],
  edges: [
    { from: "P", to: "C1", offFocus: false },
    { from: "P", to: "C2", offFocus: false },
    { from: "P", to: "C3", offFocus: false }
  ]
}), "P");

console.log(failed === 0
  ? "\nEDGE-OVER-NODE: PASS — no edge passes through a node body in any tested topology."
  : `\nEDGE-OVER-NODE: FAIL — ${failed} check(s) failed.`);
process.exit(failed === 0 ? 0 : 1);
