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

console.log(failed === 0
  ? "\nCOLLAPSIBLE-REVEAL: PASS — accordion + incremental reveal work for rec/unbound."
  : `\nCOLLAPSIBLE-REVEAL: FAIL — ${failed} check(s) failed.`);
process.exit(failed === 0 ? 0 : 1);
