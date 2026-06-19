// Verifies the side panel's collapsible (accordion) sections and incremental
// "show more / show all / show less" reveal for the Recursive and Unbound-fp
// lists, plus that caller/callee path sections are collapsible.
//
// Run: NODE_PATH=/tmp/jsdomtest/node_modules node test/collapsible-reveal-test.js
const { JSDOM } = require("jsdom");
const path = require("path");
const Module = require("module");
const realLoad = Module._load;
Module._load = function (r) {
  if (r === "vscode") return {
    EventEmitter: class { constructor() { this.event = () => ({ dispose() {} }); } fire() {} },
    Uri: { joinPath: (...a) => ({ fsPath: a.join("/") }) },
    window: {}, workspace: { getConfiguration: () => ({ get: (k, d) => d }) }
  };
  return realLoad.apply(this, arguments);
};
const { SidePanelProvider } = require(path.join(__dirname, "..", "out", "sidePanel.js"));

let failed = 0;
function check(name, cond, extra) {
  console.log((cond ? "  ok  " : " FAIL ") + name + (cond ? "" : "  " + (extra || "")));
  if (!cond) failed++;
}

const p = new SidePanelProvider({
  getState: () => ({ byName: new Map(), depth: new Map(), pinnedRoots: new Set(), thresholdWarn: 1024, thresholdCritical: 4096 }),
  onQuery: () => {}, log: { info() {}, warn() {}, error() {} }
});
const html = p.getHtml({ cspSource: "x", asWebviewUri: (u) => u, options: {}, onDidReceiveMessage: () => ({ dispose() {} }), postMessage: () => {} });
const dom = new JSDOM(html, { runScripts: "outside-only", pretendToBeVisual: true });
const w = dom.window;
w.acquireVsCodeApi = () => ({ postMessage: () => {}, getState: () => ({}), setState: () => {} });
const script = html.match(/<script>([\s\S]*?)<\/script>/)[1];
try { new w.Function(script).call(w); } catch (e) { console.error("script threw:", e.message); process.exit(1); }
const doc = w.document;

function visibleRows(wrap) {
  let v = 0; for (const r of wrap.children) if (r.style.display !== "none") v++; return v;
}

// ── Unbound fp: 12 entries → 8 shown, reveal works, header collapses ──
const unbound = [];
for (let i = 0; i < 12; i++) unbound.push({ name: "fp" + i, file: "/a.c", sites: 1, peak: 100 + i });
w.dispatchEvent(new w.MessageEvent("message", { data: { type: "unboundFp", entries: unbound } }));
const ubDiv = doc.getElementById("unbound");
const ubWrap = ubDiv.querySelector(".reveal-wrap");
check("unbound: renders all 12 rows", ubWrap.children.length === 12);
check("unbound: initially shows 8", visibleRows(ubWrap) === 8, `got ${visibleRows(ubWrap)}`);
ubDiv.querySelector('[data-reveal="step"]').dispatchEvent(new w.Event("click"));
check("unbound: 'show more' reveals next chunk", visibleRows(ubWrap) > 8);
ubDiv.querySelector('[data-reveal="all"]').dispatchEvent(new w.Event("click"));
check("unbound: 'show all' reveals everything", visibleRows(ubWrap) === 12);
ubDiv.querySelector('[data-reveal="less"]').dispatchEvent(new w.Event("click"));
check("unbound: 'show less' collapses back", visibleRows(ubWrap) <= 8);

const ubHead = doc.querySelector('[data-collapse="unbound"]');
const ubBody = doc.getElementById("unbound-body");
check("unbound: header is collapsible", !!ubHead && !!ubBody);
check("unbound: body starts collapsed (default closed)", ubBody.classList.contains("hidden"));
check("unbound: body truly hidden when collapsed (display:none)", w.getComputedStyle(ubBody).display === "none",
      w.getComputedStyle(ubBody).display);
check("unbound: header marked collapsed (arrow)", ubHead.classList.contains("collapsed"));
ubHead.dispatchEvent(new w.Event("click"));
check("unbound: click expands body", !ubBody.classList.contains("hidden"));
ubHead.dispatchEvent(new w.Event("click"));
check("unbound: click again collapses body", ubBody.classList.contains("hidden"));

// ── Recursive: 10 entries → 8 shown, reveal + collapse ──
const rec = [];
for (let i = 0; i < 10; i++) rec.push({ name: "r" + i, file: "/a.c", viaFp: i % 2 === 0, peak: 200 + i });
w.dispatchEvent(new w.MessageEvent("message", { data: { type: "recursion", entries: rec } }));
const recDiv = doc.getElementById("rec");
const recWrap = recDiv.querySelector(".reveal-wrap");
check("recursive: renders all 10 rows", recWrap.children.length === 10);
check("recursive: initially shows 8", visibleRows(recWrap) === 8, `got ${visibleRows(recWrap)}`);
recDiv.querySelector('[data-reveal="all"]').dispatchEvent(new w.Event("click"));
check("recursive: 'show all' reveals everything", visibleRows(recWrap) === 10);
const recHead = doc.querySelector('[data-collapse="rec"]');
const recBody = doc.getElementById("rec-body");
check("recursive: body starts collapsed (default closed)", recBody.classList.contains("hidden"));
recHead.dispatchEvent(new w.Event("click"));
check("recursive: header expands body", !recBody.classList.contains("hidden"));
recHead.dispatchEvent(new w.Event("click"));
check("recursive: header collapses body again", recBody.classList.contains("hidden"));

// ── Caller / callee path sections are collapsible too ──
function mkPaths(prefix, n) {
  const arr = [];
  for (let i = 0; i < n; i++) arr.push({ nodes: [prefix + i, "mid", "leaf"], totalStack: 500 - i, rootIsPinned: false });
  return arr;
}
w.dispatchEvent(new w.MessageEvent("message", { data: { type: "result", payload: {
  name: "target", file: "a.c", nameLine: 1, recursive: false, recursiveViaFp: false,
  fpVerified: false, pinnedRoot: false, autoRoot: false, depth: 3,
  stackBytes: 64, cumulativeStack: 900, cumulativeBounded: false,
  perRoot: [], outgoing: mkPaths("callee", 15), incoming: mkPaths("caller", 4),
  cycles: [], outgoingTotal: 15, incomingTotal: 4,
  pathCap: 500, thresholdWarn: 1024, thresholdCritical: 4096
} } }));
const result = doc.getElementById("result");
const headers = Array.from(result.querySelectorAll(".section-label.collapsible"));
const labels = headers.map(h => h.textContent.replace(/[▶\s]+/g, " ").trim());
check("callers section is collapsible", headers.some(h => /Callers/.test(h.textContent)));
check("callees (Calls into) section is collapsible", headers.some(h => /Calls into/.test(h.textContent)));
// Collapsing the callees header hides its rows.
const calleeHead = headers.find(h => /Calls into/.test(h.textContent));
if (calleeHead) {
  const cbody = result.querySelector('[data-collapse-body="' + calleeHead.getAttribute("data-collapse") + '"]');
  check("callee body present", !!cbody);
  calleeHead.dispatchEvent(new w.Event("click"));
  check("callee header collapses its rows", cbody && cbody.classList.contains("hidden"));
  // The body must actually be hidden (display:none), not just carry the class —
  // this catches the bug where .reveal-wrap had no matching .hidden CSS rule.
  check("callee body is truly hidden (display:none)",
        cbody && w.getComputedStyle(cbody).display === "none",
        cbody ? w.getComputedStyle(cbody).display : "no body");
  calleeHead.dispatchEvent(new w.Event("click"));
  check("callee body shows again after re-expand",
        cbody && w.getComputedStyle(cbody).display !== "none");
  calleeHead.dispatchEvent(new w.Event("click"));  // collapse again for later checks
  // Incremental reveal still present on the callee list (15 > initial).
  check("callee list has reveal controls (incremental)",
        !!result.querySelector('[data-reveal="all"]'));
}

// Top-by-peak is collapsible too.
{
  w.dispatchEvent(new w.MessageEvent("message", { data: { type: "top", entries: [
    { name: "fnA", file: "/s/a.c", peak: 900, bounded: false, recursive: false, recursiveViaFp: false, pinnedRoot: false, autoRoot: false },
    { name: "fnB", file: "/s/b.c", peak: 100, bounded: false, recursive: false, recursiveViaFp: false, pinnedRoot: false, autoRoot: false }
  ] } }));
  const topHead = w.document.querySelector('.section-label.collapsible[data-collapse="top"]');
  const topBody = w.document.getElementById("top-body");
  check("Top-by-peak section is collapsible", !!topHead && !!topBody);
  check("Top-by-peak body collapsed by default", topBody && topBody.classList.contains("hidden"));
  check("Top-by-peak body truly hidden when collapsed (display:none)",
        topBody && w.getComputedStyle(topBody).display === "none");
  if (topHead) topHead.dispatchEvent(new w.Event("click"));
  check("Top-by-peak expands on click", topBody && !topBody.classList.contains("hidden"));
}

// Top-by-depth section (mirrors top-by-peak; ranks by downward depth, shows d:N).
{
  w.dispatchEvent(new w.MessageEvent("message", { data: { type: "topDepth", entries: [
    { name: "deepRoot", file: "/s/deep.c", depth: 150, bounded: false, pinnedRoot: true },
    { name: "midFn",    file: "/s/m.c",    depth: 7,   bounded: false },
    { name: "leafFn",   file: "/s/l.c",    depth: 1,   bounded: false }
  ] } }));
  const tdHead = w.document.querySelector('.section-label.collapsible[data-collapse="top-depth"]');
  const tdBody = w.document.getElementById("top-depth-body");
  const tdRows = w.document.querySelectorAll("#top-depth .top-row");
  check("Top-by-depth section is collapsible", !!tdHead && !!tdBody);
  check("Top-by-depth body collapsed by default", tdBody && tdBody.classList.contains("hidden"));
  check("Top-by-depth renders all rows (3)", tdRows.length === 3, `rows=${tdRows.length}`);
  check("Top-by-depth count badge reflects total", w.document.getElementById("top-depth-count").textContent === "3");
  check("Top-by-depth shows depth as d:N, deepest first",
        tdRows[0] && /d:150/.test(tdRows[0].querySelector(".stat-value").textContent),
        tdRows[0] ? tdRows[0].querySelector(".stat-value").textContent : "no rows");
  if (tdHead) tdHead.dispatchEvent(new w.Event("click"));
  check("Top-by-depth expands on click", tdBody && !tdBody.classList.contains("hidden"));
}

// ── Top by frame (own stack frame, same format as Top by peak) ──
{
  w.dispatchEvent(new w.MessageEvent("message", { data: { type: "topFrame", entries: [
    { name: "bigBuf",  file: "/s/b.c", frame: 8192, qualifier: "static", peak: 9000 },
    { name: "midBuf",  file: "/s/m.c", frame: 256,  qualifier: "static", peak: 400 },
    { name: "tiny",    file: "/s/t.c", frame: 16,   qualifier: "static", peak: 16 }
  ] } }));
  const tfHead = w.document.querySelector('.section-label.collapsible[data-collapse="top-frame"]');
  const tfBody = w.document.getElementById("top-frame-body");
  const tfRows = w.document.querySelectorAll("#top-frame .top-row");
  check("Top-by-frame section is collapsible", !!tfHead && !!tfBody);
  check("Top-by-frame body collapsed by default", tfBody && tfBody.classList.contains("hidden"));
  check("Top-by-frame renders all rows (3)", tfRows.length === 3, `rows=${tfRows.length}`);
  check("Top-by-frame count badge reflects total", w.document.getElementById("top-frame-count").textContent === "3");
  check("Top-by-frame shows the OWN frame in bytes, fattest first",
        tfRows[0] && /8(\.0+)?\s*KB|8192/.test(tfRows[0].querySelector(".stat-value").textContent),
        tfRows[0] ? tfRows[0].querySelector(".stat-value").textContent : "no rows");
  check("Top-by-frame label reads 'Top by frame'", tfHead && /Top by frame/.test(tfHead.textContent));
  if (tfHead) tfHead.dispatchEvent(new w.Event("click"));
  check("Top-by-frame expands on click", tfBody && !tfBody.classList.contains("hidden"));
}

// Callers / Calls into sort toggle: stack (heaviest first) vs hops (longest chain first).
{
  w.dispatchEvent(new w.MessageEvent("message", { data: { type: "result", payload: {
    name: "tgt", file: "a.c", nameLine: 1, recursive: false, recursiveViaFp: false,
    fpVerified: false, pinnedRoot: false, autoRoot: false, depth: 3,
    stackBytes: 64, cumulativeStack: 900, cumulativeBounded: false, perRoot: [], cycles: [],
    incoming: [
      { nodes: ["aa", "bb", "tgt"], totalStack: 100, rootIsPinned: false },  // 3 hops, light
      { nodes: ["cc", "tgt"], totalStack: 500, rootIsPinned: false }          // 2 hops, heavy
    ],
    outgoing: [], incomingTotal: 2, outgoingTotal: 0, pathCap: 500,
    thresholdWarn: 1024, thresholdCritical: 4096
  } } }));
  const res = doc.getElementById("result");
  const firstChain = () => { const c = res.querySelector(".path .path-chain"); return c ? c.textContent.replace(/\s+/g, " ").trim() : ""; };
  const sortBtns = res.querySelectorAll('[data-sortsec="callers"]');
  check("Callers section has a stack/hops sort toggle", sortBtns.length === 2, `got ${sortBtns.length}`);
  check("Callers default sort is by stack (heaviest chain first)", /^cc/.test(firstChain()), firstChain());
  const hopsBtn = Array.from(sortBtns).find(b => b.getAttribute("data-sortby") === "hops");
  if (hopsBtn) hopsBtn.dispatchEvent(new w.MouseEvent("click", { bubbles: true }));
  check("Callers sort-by-hops reorders (longest chain first)", /^aa/.test(firstChain()), firstChain());
  check("the hops sort button becomes active", !!res.querySelector('[data-sortsec="callers"][data-sortby="hops"].active'));
}

// A background re-query (analysis refresh) must NOT yank the user off Overview.
{
  const tFn = doc.getElementById("tab-function");
  const tOv = doc.getElementById("tab-overview");
  const payload = { name: "stayfn", file: "a.c", nameLine: 1, recursive: false, recursiveViaFp: false,
    fpVerified: false, pinnedRoot: false, autoRoot: false, depth: 1, stackBytes: 64,
    cumulativeStack: 100, cumulativeBounded: false, perRoot: [], outgoing: [], incoming: [],
    cycles: [], outgoingTotal: 0, incomingTotal: 0, pathCap: 500, thresholdWarn: 1024, thresholdCritical: 4096 };
  // 1) user opens a function -> Function tab becomes active
  w.dispatchEvent(new w.MessageEvent("message", { data: { type: "result", payload } }));
  check("opening a function activates the Function tab", tFn.classList.contains("active"));
  // 2) user switches to Overview
  tOv.dispatchEvent(new w.Event("click"));
  check("user can switch to Overview", tOv.classList.contains("active"));
  // 3) analysis update arrives (recursion = last step) -> fires an auto re-query
  w.dispatchEvent(new w.MessageEvent("message", { data: { type: "recursion", entries: [] } }));
  // 4) the auto re-query result returns -> must NOT steal the tab
  w.dispatchEvent(new w.MessageEvent("message", { data: { type: "result", payload } }));
  check("background re-query keeps the user on Overview",
        tOv.classList.contains("active") && !tFn.classList.contains("active"));
  // 5) an explicit lookup (externalQuery) still switches to the Function tab
  w.dispatchEvent(new w.MessageEvent("message", { data: { type: "externalQuery", name: "stayfn" } }));
  w.dispatchEvent(new w.MessageEvent("message", { data: { type: "result", payload } }));
  check("an explicit lookup still switches to the Function tab", tFn.classList.contains("active"));
}

// Dynamic refresh: EVERY Overview list re-renders when a new analysis update
// arrives (the host re-posts top / topDepth / recursion / unboundFp each time).
{
  const send = (m) => w.dispatchEvent(new w.MessageEvent("message", { data: m }));
  const topDiv2 = doc.getElementById("top");
  const tdDiv2 = doc.getElementById("top-depth");
  const tfDiv2 = doc.getElementById("top-frame");
  const recDiv2 = doc.getElementById("rec");
  const ubDiv2 = doc.getElementById("unbound");
  const recBlk2 = doc.getElementById("rec-block");
  const ubBlk2 = doc.getElementById("unbound-block");
  const mkTop = (name, peak) => ({ name, file: "/" + name + ".c", peak, bounded: false, recursive: false, recursiveViaFp: false, pinnedRoot: false, autoRoot: false });

  // ── round 1 ──
  send({ type: "top", entries: [mkTop("r1_top_a", 5000), mkTop("r1_top_b", 1000)] });
  send({ type: "topDepth", entries: [{ name: "r1_depth_a", file: "/a.c", depth: 50, bounded: false }] });
  send({ type: "recursion", entries: [{ name: "r1_rec_a", file: "/a.c", viaFp: false, peak: 200, hops: 1 }] });
  send({ type: "unboundFp", entries: [{ name: "r1_ub_a", file: "/a.c", sites: 1, peak: 300 }] });
  send({ type: "topFrame", entries: [{ name: "r1_frame_a", file: "/a.c", frame: 2048, qualifier: "static" }] });
  check("round1: Top by peak shows initial entry", topDiv2.textContent.includes("r1_top_a"));
  check("round1: Top by depth shows initial entry", tdDiv2.textContent.includes("r1_depth_a"));
  check("round1: Top by frame shows initial entry", tfDiv2.textContent.includes("r1_frame_a"));
  check("round1: Recursive shows initial entry", recDiv2.textContent.includes("r1_rec_a"));
  check("round1: Unbound fp shows initial entry", ubDiv2.textContent.includes("r1_ub_a"));

  // ── round 2: new analysis — different content; recursion goes empty ──
  send({ type: "top", entries: [mkTop("r2_top_x", 8000), mkTop("r2_top_y", 9000), mkTop("r2_top_z", 100)] });
  send({ type: "topDepth", entries: [{ name: "r2_depth_x", file: "/x.c", depth: 99, bounded: false }, { name: "r2_depth_y", file: "/y.c", depth: 12, bounded: false }] });
  send({ type: "unboundFp", entries: [{ name: "r2_ub_x", file: "/x.c", sites: 2, peak: 600 }] });
  send({ type: "topFrame", entries: [{ name: "r2_frame_x", file: "/x.c", frame: 4096, qualifier: "static" }, { name: "r2_frame_y", file: "/y.c", frame: 64, qualifier: "static" }] });
  send({ type: "recursion", entries: [] });

  check("refresh: Top by peak swaps in new entries, drops old",
        topDiv2.textContent.includes("r2_top_x") && !topDiv2.textContent.includes("r1_top_a"));
  check("refresh: Top by peak count badge updates to 3",
        doc.getElementById("top-count").textContent === "3");
  check("refresh: Overview tab badge updates to 3",
        (doc.querySelector("#tab-overview .tab-badge") || {}).textContent === "3");
  check("refresh: Top by depth swaps in new entries, drops old",
        tdDiv2.textContent.includes("r2_depth_x") && !tdDiv2.textContent.includes("r1_depth_a"));
  check("refresh: Top by depth count badge updates to 2",
        doc.getElementById("top-depth-count").textContent === "2");
  check("refresh: Top by depth re-sorts (deepest first)",
        /r2_depth_x[\s\S]*r2_depth_y/.test(tdDiv2.textContent));
  check("refresh: Top by frame swaps in new entries, drops old",
        tfDiv2.textContent.includes("r2_frame_x") && !tfDiv2.textContent.includes("r1_frame_a"));
  check("refresh: Top by frame count badge updates to 2",
        doc.getElementById("top-frame-count").textContent === "2");
  check("refresh: Unbound fp swaps in new entries, drops old",
        ubDiv2.textContent.includes("r2_ub_x") && !ubDiv2.textContent.includes("r1_ub_a") && ubBlk2.style.display !== "none");
  check("refresh: Recursive list clears + hides when the new analysis has none",
        recBlk2.style.display === "none");
}

// ── Recursion paths: numbered steps + explicit loop-back (no repeated node) ──
{
  w.dispatchEvent(new w.MessageEvent("message", { data: { type: "result", payload: {
    name: "parse_expr", file: "p.c", nameLine: 1, recursive: true, recursiveViaFp: false,
    fpVerified: false, pinnedRoot: false, autoRoot: false, depth: 1,
    stackBytes: 64, cumulativeStack: 1200, cumulativeBounded: true,
    perRoot: [], outgoing: [], incoming: [], outgoingTotal: 0, incomingTotal: 0,
    cyclesTruncated: false, cyclesLimitHit: null,
    cycles: [{ nodes: ["parse_expr", "parse_term", "parse_factor", "parse_expr"],
               totalStack: 1200, truncatedByCycle: true, rootIsPinned: false }],
    pathCap: 500, thresholdWarn: 1024, thresholdCritical: 4096
  } } }));
  const res = doc.getElementById("result");
  const steps = Array.from(res.querySelectorAll(".cycle-steps .cycle-row:not(.cycle-back)"));
  check("recursion: cycle is rendered as numbered steps", steps.length === 3, `steps=${steps.length}`);
  const nums = steps.map(r => r.querySelector(".step-no").textContent.trim());
  check("recursion: steps are numbered 1..N", nums.join(",") === "1,2,3", nums.join(","));
  const stepNames = steps.map(r => r.querySelector(".fn-clickable").getAttribute("data-fn"));
  check("recursion: each step is a DISTINCT node (start not repeated)",
        stepNames.join(",") === "parse_expr,parse_term,parse_factor", stepNames.join(","));
  const back = res.querySelector(".cycle-row.cycle-back");
  check("recursion: explicit loop-back row 'back to 1' present", !!back && /back to 1/.test(back.textContent), back && back.textContent);
  check("recursion: loop-back gutter is ↺ (not a plain arrow)",
        back && back.querySelector(".step-no").textContent.trim() === "↺");
  check("recursion: loop-back links to the start node (clickable)",
        !!(back && back.querySelector('[data-fn="parse_expr"]')));
  const head = res.querySelector(".cycle-steps .cycle-head");
  check("recursion: header shows the loop + hop count", !!head && /3 hops/.test(head.textContent) && /loop/.test(head.textContent));
  check("recursion: no horizontal arrow chain (.path-chain) used for the cycle",
        res.querySelectorAll(".cycle-steps .path-chain").length === 0);
}

console.log(failed === 0
  ? "\nCOLLAPSIBLE-REVEAL: PASS — accordion + incremental reveal work for rec/unbound."
  : `\nCOLLAPSIBLE-REVEAL: FAIL — ${failed} check(s) failed.`);
process.exit(failed === 0 ? 0 : 1);
