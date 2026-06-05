// Verifies the side panel makes function-pointer call sites fast to reach:
//   - the "line N" of each fp site is clickable and jumps to source (open)
//   - each inferred target is a clickable function link (goto / open in panel)
//
// Run: NODE_PATH=/tmp/jsdomtest/node_modules node test/fp-site-link-test.js
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
const posted = [];
w.acquireVsCodeApi = () => ({ postMessage: (m) => posted.push(m), getState: () => ({}), setState: () => {} });
new w.Function(html.match(/<script>([\s\S]*?)<\/script>/)[1]).call(w);

w.dispatchEvent(new w.MessageEvent("message", { data: { type: "result", payload: {
  name: "dispatch", file: "src/drv.c", nameLine: 10, recursive: false, recursiveViaFp: false,
  fpVerified: false, pinnedRoot: false, autoRoot: false, depth: 2,
  stackBytes: 32, cumulativeStack: 200, cumulativeBounded: false,
  perRoot: [], outgoing: [], incoming: [], cycles: [], outgoingTotal: 0, incomingTotal: 0,
  pathCap: 500, thresholdWarn: 1024, thresholdCritical: 4096,
  fpSites: [
    { line: 42, via: "cb", candidates: ["handler_a", "handler_b"], overridden: false },
    { line: 50, via: "tbl", candidates: ["op_x"], overridden: true }
  ]
} } }));

const res = w.document.getElementById("result");

// 1) Line link present + jumps to the call site (file + line, 0-based).
const locLinks = res.querySelectorAll(".fp-loc-link");
check("each fp site has a clickable line link", locLinks.length === 2, `got ${locLinks.length}`);
const first = res.querySelector(".fp-loc-link");
first.dispatchEvent(new w.Event("click"));
const openMsg = posted.find(m => m.type === "open" && m.file === "src/drv.c" && m.line === 41);
check("clicking line 42 opens src/drv.c at line 41 (0-based)", !!openMsg,
      JSON.stringify(posted.filter(m => m.type === "open")));

// 2) Inferred targets are clickable function links.
const tgtLinks = res.querySelectorAll(".fp-tgts .fn-clickable");
check("inferred targets are function links", tgtLinks.length >= 2,
      `got ${tgtLinks.length}`);
posted.length = 0;
const ta = Array.from(tgtLinks).find(e => e.textContent === "handler_a");
check("target 'handler_a' is a link", !!ta);
ta.dispatchEvent(new w.Event("click"));
check("clicking target opens it in panel (goto handler_a)",
      posted.some(m => m.type === "goto" && m.name === "handler_a"));

// 3) Target links also get hover + context menu (shared data-fn wiring).
posted.length = 0;
ta.dispatchEvent(new w.MouseEvent("contextmenu", { bubbles: true, cancelable: true }));
const menu = w.document.getElementById("ctx-menu");
check("right-clicking a target opens the context menu",
      menu && menu.style.display === "block");
ta.dispatchEvent(new w.Event("mouseenter"));
check("hovering a target requests its info (tooltip)",
      posted.some(m => m.type === "requestFnInfo" && m.name === "handler_a") ||
      (ta.getAttribute("title") || "").includes("handler_a"));

console.log(failed === 0
  ? "\nFP-SITE-LINK: PASS — fp call sites jump to source and targets are clickable."
  : `\nFP-SITE-LINK: FAIL — ${failed} check(s) failed.`);
process.exit(failed === 0 ? 0 : 1);
