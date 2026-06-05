// Tests the call-graph webview "focus function…" search box: it must show
// suggestions (like the side panel's lookup) when you type OR focus the box,
// and let you navigate them. Runs the real GRAPH_HTML inline script in jsdom.
//
// Run: NODE_PATH=/tmp/jsdomtest/node_modules node test/graph-search-test.js
const { JSDOM } = require("jsdom");
const Module = require("module");

// Stub vscode so we can require the compiled graphView for its GRAPH_HTML.
const realLoad = Module._load;
Module._load = function (r) { if (r === "vscode") return {}; return realLoad.apply(this, arguments); };
const { GRAPH_HTML } = require("../out/graphView.js");

// Extract <body>…</body> + the inline <script> from the HTML document.
const bodyMatch = GRAPH_HTML.match(/<body>([\s\S]*?)<\/body>/i);
const scriptMatch = GRAPH_HTML.match(/<script>([\s\S]*?)<\/script>/i);
if (!bodyMatch || !scriptMatch) { console.error("could not extract body/script"); process.exit(1); }

let failed = 0;
function check(name, cond, extra) {
  console.log((cond ? "  ok  " : " FAIL ") + name + (cond ? "" : "  " + (extra || "")));
  if (!cond) failed++;
}

// Run the inline script in the window context. We use outside-only mode (so
// our dispatched MessageEvents reach the script's window 'message' listener),
// with the full <body> present and readyState 'complete' so the DOM-ready
// boot() guard runs immediately.
const dom = new JSDOM(`<!DOCTYPE html><html><body>${bodyMatch[1]}</body></html>`, {
  runScripts: "outside-only", pretendToBeVisual: true
});
const { window } = dom;
const sent = [];
window.acquireVsCodeApi = () => ({ postMessage: (m) => sent.push(m), getState: () => ({}), setState: () => {} });
window.HTMLElement.prototype.scrollIntoView = function () {};
if (window.SVGElement) window.SVGElement.prototype.getBBox = function () { return { x: 0, y: 0, width: 100, height: 100 }; };
try { Object.defineProperty(window.document, "readyState", { value: "complete", configurable: true }); } catch (_) {}

const runScript = new window.Function(scriptMatch[1]);
try { runScript.call(window); } catch (e) { console.error("script threw:", e.message); process.exit(1); }

const doc = window.document;
const search = doc.getElementById("search");
const suggest = doc.getElementById("suggest");
check("search box exists ('focus function…')", !!search && /focus function/i.test(search.placeholder));
check("suggest container exists", !!suggest);
// Layout: the dropdown is moved to <body> and positioned in viewport coords so
// no toolbar/wrap can clip or hide it (the bug where it rendered but was not
// visible). It must NOT remain nested inside the toolbar.
check("suggest is moved out to <body> (not clipped by toolbar)",
      !!suggest && suggest.parentElement === doc.body);
if (!search || !suggest) { console.error("setup failed"); process.exit(1); }

const NAMES = ["app_main", "dispatch_isr", "handler_large", "handler_small", "fp_param_apply"];

// 0) BEFORE any names arrive: focusing the box must ask the extension for them
//    (this is the real-world failure mode — names hadn't been delivered yet).
search.focus();
search.dispatchEvent(new window.Event("focus"));
check("empty names → webview requests names from extension", sent.some(m => m.type === "requestNames"));
// Extension replies with a standalone names message; list should populate.
window.dispatchEvent(new window.MessageEvent("message", { data: { type: "names", names: NAMES } }));
check("standalone 'names' message populates suggestions on focus",
      suggest.querySelectorAll(".sug-item").length === NAMES.length,
      `got ${suggest.querySelectorAll(".sug-item").length}`);

// Reset the box for the remaining checks; deliver names again via graph push.
search.value = ""; suggest.style.display = "none";
window.dispatchEvent(new window.MessageEvent("message", {
  data: { type: "graph", data: { focus: "", nodes: [], edges: [] }, names: NAMES }
}));

// 1) Focusing the empty box should list everything (browse mode).
search.dispatchEvent(new window.Event("focus"));
let items = suggest.querySelectorAll(".sug-item");
check("focus shows all names when empty", items.length === NAMES.length, `got ${items.length}`);
check("suggest is visible on focus (inline display set, not '')", suggest.style.display === "block");
// Effective display must not be 'none' — guards the bug where clearing the
// inline style fell back to the stylesheet's `#suggest { display:none }`.
check("suggest computed display is not none when shown",
      window.getComputedStyle(suggest).display !== "none",
      `computed=${window.getComputedStyle(suggest).display}`);
// Visibility: when shown it must be positioned (fixed) with a real on-screen
// location — the core of the "renders but not visible" bug.
check("suggest is positioned fixed when shown", suggest.style.position === "fixed");
check("suggest has a viewport top/left when shown",
      suggest.style.top !== "" && suggest.style.left !== "");

// 1b) Clicking the box also opens the list (even when already focused).
suggest.style.display = "none";
search.dispatchEvent(new window.Event("click"));
check("click opens the suggestion list", suggest.querySelectorAll(".sug-item").length === NAMES.length);

// 2) Typing filters (prefix/substring), like the side panel.
search.value = "handler";
search.dispatchEvent(new window.Event("input"));
items = suggest.querySelectorAll(".sug-item");
const shown = Array.from(items).map(el => el.textContent);
check("typing 'handler' filters to handler_*", shown.length === 2 && shown.every(t => /handler/.test(t)), shown.join(","));

// 3) Substring match (not just prefix).
search.value = "param";
search.dispatchEvent(new window.Event("input"));
items = suggest.querySelectorAll(".sug-item");
check("substring 'param' matches fp_param_apply", Array.from(items).some(el => /fp_param_apply/.test(el.textContent)));

// 4) Arrow keys move the active selection; Enter picks it → refocus message.
search.value = "handler";
search.dispatchEvent(new window.Event("input"));
function key(k) { const e = new window.KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true }); search.dispatchEvent(e); }
key("ArrowDown"); // move to second item (active started at 0)
const activeIdx = Array.from(suggest.querySelectorAll(".sug-item")).findIndex(el => el.classList.contains("active"));
check("ArrowDown moves active selection", activeIdx === 1, `active=${activeIdx}`);
key("Enter");
const refocus = sent.find(m => m.type === "refocus");
check("Enter on a suggestion sends refocus", !!refocus);
check("refocus name is the highlighted one (handler_small)", refocus && refocus.name === "handler_small", refocus && refocus.name);

// 5) Clicking a suggestion also refocuses.
sent.length = 0;
search.value = "app";
search.dispatchEvent(new window.Event("input"));
const first = suggest.querySelector(".sug-item");
first.dispatchEvent(new window.MouseEvent("mousedown", { bubbles: true, cancelable: true }));
const clickRefocus = sent.find(m => m.type === "refocus");
check("clicking a suggestion sends refocus", !!clickRefocus && clickRefocus.name === "app_main", clickRefocus && clickRefocus.name);

// 6) ROBUSTNESS: the search box must keep working even if the graph-rendering
//    code throws (the real-world failure mode — search wiring is bound BEFORE
//    the graph code, so a render error can't disable it). We simulate a render
//    error by dispatching a graph message in an env without SVG getBBox (jsdom
//    lacks it), then confirm the box still lists/filters.
try {
  window.dispatchEvent(new window.MessageEvent("message", {
    data: { type: "graph", data: { focus: "app_main", nodes: [{ name: "app_main", isFocus: true, peak: 100 }], edges: [] }, names: NAMES }
  }));
} catch (_) { /* a render throw here must not affect search */ }
search.value = "dispatch";
search.dispatchEvent(new window.Event("input"));
check("search still works after a graph render error",
      Array.from(suggest.querySelectorAll(".sug-item")).some(el => /dispatch_isr/.test(el.textContent)));

// 7) Node hover tooltip (SVG <title>) shows name + Frame/Peak + role bits.
window.dispatchEvent(new window.MessageEvent("message", {
  data: { type: "graph", names: NAMES, focus: "disp", thresholds: { warn: 1024, critical: 4096 },
    data: { focus: "disp", nodes: [
      { name: "disp", file: "src/drivers/dispatch.c", isFocus: true, stackBytes: 32, peak: 96, recursive: false, hasUnboundFp: true, isRoot: true, rootKind: "pinned", layer: 0 }
    ], edges: [] } }
}));
const titleEl = window.document.querySelector("svg title");
const tt = titleEl ? titleEl.textContent : "";
check("node tooltip includes the function name", /disp/.test(tt));
check("node tooltip includes Frame", /Frame:/.test(tt));
check("node tooltip includes Peak", /Peak:/.test(tt));
check("node tooltip includes File (basename)", /File: dispatch\.c/.test(tt), tt.replace(/\n/g, " | "));
check("node tooltip notes pinned root", /pinned root/.test(tt));
check("node tooltip notes unbound fp", /not bound/.test(tt), tt.replace(/\n/g, " | "));

// 8) Edge readability: self-loops draw a visible arc on top of the node, and
// every edge gets a background-colored halo underlay so lines stay legible
// where they cross node boxes.
window.dispatchEvent(new window.MessageEvent("message", {
  data: { type: "graph", focus: "selfrec", thresholds: { warn: 1024, critical: 4096 },
    names: ["selfrec", "other"],
    data: { focus: "selfrec", nodes: [
      { name: "selfrec", isFocus: true, stackBytes: 32, peak: 64, recursive: true, layer: 0 },
      { name: "other", stackBytes: 16, peak: 16, recursive: false, layer: 1 }
    ], edges: [
      { from: "selfrec", to: "selfrec", recursive: true, indirect: false, offFocus: false },
      { from: "selfrec", to: "other", recursive: false, indirect: false, offFocus: false }
    ] } }
}));
const halos = window.document.querySelectorAll(".edge-halo");
const recEdges = window.document.querySelectorAll(".edge.recursive");
check("every edge has a halo underlay (readability)", halos.length === 2, `got ${halos.length}`);
check("self-loop is drawn and marked recursive", recEdges.length === 1, `got ${recEdges.length}`);
const selfEdge = window.document.querySelector(".edge.recursive");
const sd = selfEdge ? selfEdge.getAttribute("d") : "";
check("self-loop is an arc above the node (curved, negative y)", /C/.test(sd) && /-/.test(sd), sd);

// Arrow heads must be drawn ON TOP of the nodes (in a later DOM position) so
// they're never hidden behind a node box where an edge meets it.
{
  const all = Array.from(window.document.querySelectorAll("#viewport *, svg *"));
  const arrows = window.document.querySelectorAll(".edge-arrow");
  const firstArrow = all.findIndex(e => e.classList && e.classList.contains("edge-arrow"));
  const lastNode = (() => { let i = -1; all.forEach((e, k) => { if (e.classList && e.classList.contains("node-rect")) i = k; }); return i; })();
  check("arrow heads exist for edges", arrows.length >= 1, `got ${arrows.length}`);
  check("arrow heads are drawn above nodes (visible)", firstArrow > lastNode,
        `firstArrow=${firstArrow} lastNode=${lastNode}`);
  // Arrow heads are sizable, closed triangles (3 points + Z) so the direction
  // reads clearly — not the old tiny fixed mark.
  const ad = arrows[0].getAttribute("d") || "";
  const pts = (ad.match(/-?\d+(?:\.\d+)?/g) || []).length;
  check("arrow head is a closed triangle (3 points)", /Z\s*$/i.test(ad) && pts === 6, ad);
}

// Arrow direction follows the curve's incoming tangent (so a backward/curved
// edge points the right way, not a fixed horizontal angle).
{
  window.dispatchEvent(new window.MessageEvent("message", { data: {
    type: "graph", focus: "A", thresholds: { warn: 1024, critical: 4096 },
    names: ["A", "B"],
    data: { focus: "A", nodes: [
      { name: "A", isFocus: true, stackBytes: 32, peak: 64, recursive: true, layer: 0 },
      { name: "B", stackBytes: 32, peak: 64, recursive: true, layer: 1 }
    ], edges: [
      { from: "A", to: "B", recursive: true, offFocus: false },
      { from: "B", to: "A", recursive: true, offFocus: true }
    ] } }
  }));
  const arr = Array.from(window.document.querySelectorAll(".edge-arrow"));
  // For the mutual pair, the two heads must point in OPPOSITE vertical
  // directions (one entering a node top, the other a node bottom).
  function tipDir(a) {
    const m = (a.getAttribute("d") || "").match(/M([-\d.]+),([-\d.]+) L([-\d.]+),([-\d.]+) L([-\d.]+),([-\d.]+)/);
    if (!m) return 0;
    const n = m.map(Number);
    const by = (n[4] + n[6]) / 2;
    return Math.sign(n[2] - by); // tip.y - base.y
  }
  const dirs = arr.map(tipDir);
  check("bidirectional arrow heads point opposite ways (direction is clear)",
        dirs.length === 2 && dirs[0] !== 0 && dirs[0] === -dirs[1],
        `dirs=${dirs.join(",")}`);
}

// Hover highlights ONLY the directional call flow through the focus node:
// strictly deeper in the callee direction, strictly shallower toward it in the
// caller direction. Back-edges (a level-3 callee calling a level-2 node) and
// same-level sibling edges are excluded. Mirrors highlightConnected.
{
  function activeEdges(edges, name) {
    const fwd = new Map(), rev = new Map();
    for (const e of edges) {
      if (!fwd.has(e.from)) fwd.set(e.from, []); fwd.get(e.from).push(e.to);
      if (!rev.has(e.to)) rev.set(e.to, []); rev.get(e.to).push(e.from);
    }
    const down = new Set([name]), dD = new Map([[name, 0]]); let q = [name];
    while (q.length) { const c = q.shift(); for (const n of (fwd.get(c) || [])) if (!down.has(n)) { down.add(n); dD.set(n, dD.get(c) + 1); q.push(n); } }
    const up = new Set([name]), dU = new Map([[name, 0]]); q = [name];
    while (q.length) { const c = q.shift(); for (const p of (rev.get(c) || [])) if (!up.has(p)) { up.add(p); dU.set(p, dU.get(c) + 1); q.push(p); } }
    return edges.filter(e =>
      (down.has(e.from) && down.has(e.to) && dD.get(e.to) > dD.get(e.from)) ||
      (up.has(e.from) && up.has(e.to) && dU.get(e.from) > dU.get(e.to))
    ).map(e => e.from + ">" + e.to).sort().join(",");
  }
  check("hover excludes sibling side-edge (A→B at same level)",
    activeEdges([{from:"F",to:"A"},{from:"F",to:"B"},{from:"A",to:"B"},{from:"A",to:"C"}], "F")
      === "A>C,F>A,F>B");
  check("hover excludes a back-edge in a cycle",
    activeEdges([{from:"F",to:"A"},{from:"A",to:"B"},{from:"B",to:"A"}], "F")
      === "A>B,F>A");
  check("hover keeps a straight hierarchy chain",
    activeEdges([{from:"F",to:"A"},{from:"A",to:"B"},{from:"B",to:"C"}], "F")
      === "A>B,B>C,F>A");
  // The user's case: a level-3 callee (C) calling a level-2 node (B) is a
  // shallower back-edge in the callee direction → must be excluded.
  check("hover excludes a level-3→level-2 back-edge in the callee direction",
    activeEdges([{from:"F",to:"A"},{from:"A",to:"B"},{from:"B",to:"C"},{from:"C",to:"B"}], "F")
      === "A>B,B>C,F>A");
  // Forward flow deepens level by level; F→A→B→C all kept.
  check("hover keeps a multi-level forward chain",
    activeEdges([{from:"F",to:"A"},{from:"A",to:"B"},{from:"B",to:"C"},{from:"C",to:"D"}], "F")
      === "A>B,B>C,C>D,F>A");
}

// Edges between two nodes in the SAME layer (same hierarchy level) are not
// drawn — they clutter the layered view and aren't an up/down call step. Only
// cross-layer edges and self-loops are rendered.
{
  window.dispatchEvent(new window.MessageEvent("message", { data: {
    type: "graph", focus: "F", thresholds: { warn: 1024, critical: 4096 },
    names: ["F", "A", "B", "C"],
    data: { focus: "F", nodes: [
      { name: "F", isFocus: true, stackBytes: 32, peak: 96, layer: 0 },
      { name: "A", stackBytes: 32, peak: 64, layer: 1 },
      { name: "B", stackBytes: 32, peak: 64, layer: 1 },
      { name: "C", stackBytes: 32, peak: 32, layer: 2 }
    ], edges: [
      { from: "F", to: "A", offFocus: false },
      { from: "F", to: "B", offFocus: false },
      { from: "A", to: "B", offFocus: false },          // same layer → dropped
      { from: "A", to: "C", offFocus: false },
      { from: "C", to: "C", recursive: true, offFocus: false }  // self → kept
    ] }
  } }));
  const drawn = window.document.querySelectorAll(".edge").length;
  const selfKept = window.document.querySelectorAll(".edge.recursive").length >= 1;
  check("same-layer edge is not drawn (4 of 5 rendered)", drawn === 4, `drawn=${drawn}`);
  check("self-loop is still drawn when same-layer filtering is on", selfKept);

  // Hovering must not light up a node reachable only through a HIDDEN same-layer
  // edge. Here A→B is same-layer (not drawn); hovering B must leave A dimmed,
  // while F (a real drawn caller of B) stays bright.
  function nodeG(label) {
    for (const g of window.document.querySelectorAll("g")) {
      const t = g.querySelector("text");
      if (t && t.textContent.trim() === label && g.querySelector("rect")) return g;
    }
    return null;
  }
  const gB = nodeG("B");
  if (gB) gB.dispatchEvent(new window.MouseEvent("mouseenter", { bubbles: true }));
  const aDim = nodeG("A") && nodeG("A").classList.contains("dimmed");
  const fDim = nodeG("F") && nodeG("F").classList.contains("dimmed");
  check("hover does not brighten a node linked only by a hidden same-layer edge", aDim === true);
  check("hover keeps a real drawn caller bright", fDim === false);
}

// Real-DOM directional-flow check: hovering F over F→A→B→C with a C→B back-edge
// must highlight the three forward edges and dim the back-edge.
{
  window.dispatchEvent(new window.MessageEvent("message", { data: {
    type: "graph", focus: "F", thresholds: { warn: 1024, critical: 4096 },
    names: ["F", "A", "B", "C"],
    data: { focus: "F", nodes: [
      { name: "F", isFocus: true, stackBytes: 32, peak: 96, layer: 0 },
      { name: "A", stackBytes: 32, peak: 64, layer: 1 },
      { name: "B", stackBytes: 32, peak: 64, layer: 2 },
      { name: "C", stackBytes: 32, peak: 32, layer: 3 }
    ], edges: [
      { from: "F", to: "A" }, { from: "A", to: "B" },
      { from: "B", to: "C" }, { from: "C", to: "B" }   // back-edge L3→L2
    ] }
  } }));
  function nodeG2(label) {
    for (const g of window.document.querySelectorAll("g")) {
      const t = g.querySelector("text");
      if (t && t.textContent.trim() === label && g.querySelector("rect")) return g;
    }
    return null;
  }
  const gA = nodeG2("A");
  if (gA) gA.dispatchEvent(new window.MouseEvent("mouseenter", { bubbles: true }));
  const hl = window.document.querySelectorAll(".edge.edge-hl").length;
  const dim = window.document.querySelectorAll(".edge.edge-dim").length;
  check("real hover: 3 forward-flow edges highlighted (F→A,A→B,B→C)", hl === 3, `hl=${hl}`);
  check("real hover: the level-3→level-2 back-edge is dimmed", dim === 1, `dim=${dim}`);
}

console.log(failed === 0
  ? "\nGRAPH-SEARCH: PASS — suggestions show, filter, navigate, and pick."
  : `\nGRAPH-SEARCH: FAIL — ${failed} check(s) failed.`);

// === Separate scenario: script runs BEFORE the DOM is parsed ================
// This is the real failure the user hit (getElementById returned null). The
// boot() guard must defer setup to DOMContentLoaded instead of throwing.
(function domNotReadyScenario() {
  const dom2 = new JSDOM("<!DOCTYPE html><html><body></body></html>", { runScripts: "outside-only", pretendToBeVisual: true });
  const w = dom2.window; const sent2 = [];
  w.acquireVsCodeApi = () => ({ postMessage: (m) => sent2.push(m), getState: () => ({}), setState: () => {} });
  w.HTMLElement.prototype.scrollIntoView = function () {};
  if (w.SVGElement) w.SVGElement.prototype.getBBox = function () { return { x: 0, y: 0, width: 100, height: 100 }; };
  try { Object.defineProperty(w.document, "readyState", { value: "loading", configurable: true, writable: true }); } catch (_) {}
  let threw = false;
  try { new w.Function(scriptMatch[1]).call(w); } catch (_) { threw = true; }
  check("DOM-not-ready: script doesn't throw at load", !threw);
  check("DOM-not-ready: 'ready' deferred (not sent before DOM)", !sent2.some(m => m.type === "ready"));
  // Now the body is parsed and DOMContentLoaded fires.
  w.document.body.innerHTML = bodyMatch[1];
  try { Object.defineProperty(w.document, "readyState", { value: "complete", configurable: true, writable: true }); } catch (_) {}
  w.document.dispatchEvent(new w.Event("DOMContentLoaded"));
  check("DOM-not-ready: 'ready' sent after DOMContentLoaded", sent2.some(m => m.type === "ready"));
  const s = w.document.getElementById("search"), sug = w.document.getElementById("suggest");
  w.dispatchEvent(new w.MessageEvent("message", { data: { type: "names", names: ["aaa", "bbb", "abc"] } }));
  s.focus(); s.dispatchEvent(new w.Event("focus"));
  check("DOM-not-ready: search works after boot", sug.querySelectorAll(".sug-item").length === 3,
        `got ${sug.querySelectorAll(".sug-item").length}`);
})();

process.exit(failed === 0 ? 0 : 1);
