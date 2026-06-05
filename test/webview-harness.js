// Real webview test: render the side-panel HTML and execute its inline script
// in a DOM (jsdom), simulating the extension⇆webview message protocol. This is
// the harness used to verify the panel actually runs (no syntax error, signals
// ready, renders analysis) without needing a live VS Code instance.
//
// Usage: node test/webview-harness.js
const path = require("path");
const Module = require("module");

// Let this script resolve jsdom from the temp install location.
const JSDOM_PATH = "/tmp/jsdomtest/node_modules";
const origResolve = Module._resolveLookupPaths;
const { JSDOM } = require(path.join(JSDOM_PATH, "jsdom"));

// --- Stub the `vscode` module so we can require the compiled provider. -------
const vscodeStub = {
  EventEmitter: class { constructor(){ this.event = () => ({ dispose(){} }); } fire(){} },
  Uri: { joinPath: (...a) => ({ fsPath: a.join("/"), toString: () => a.join("/") }) },
  window: {},
  workspace: { getConfiguration: () => ({ get: (_k, d) => d }) },
  // Minimal shims so the HoverProvider can build/return a hover.
  MarkdownString: class {
    constructor(){ this.value = ""; this.isTrusted = false; this.supportHtml = false; }
    appendMarkdown(s){ this.value += s; return this; }
    appendText(s){ this.value += s; return this; }
    appendCodeblock(s){ this.value += s; return this; }
  },
  Hover: class { constructor(contents, range){ this.contents = Array.isArray(contents) ? contents : [contents]; this.range = range; } },
  Range: class { constructor(a, b){ this.start = a; this.end = b; } },
  Position: class { constructor(line, ch){ this.line = line; this.character = ch; } },
};
const realLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === "vscode") return vscodeStub;
  return realLoad.apply(this, arguments);
};

const { SidePanelProvider } = require("../out/sidePanel.js");

// --- Build a fake analysis state (a few functions, one root). ----------------
const byName = new Map([
  ["app_main", { file: "app.c", nameLine: 9, stackBytes: 128, recursive: false,
                 recursiveViaFp: false, cumulativeStack: 4800, cumulativeBounded: false,
                 depth: 1, callees: ["worker"], callers: [], indirect: [],
                 perRoot: [{ rootName: "app_main", depth: 1, entry: 128, cumulativeStack: 4800, isPinned: true }] }],
  ["worker",   { file: "w.c", nameLine: 3, stackBytes: 64, recursive: false,
                 recursiveViaFp: false, cumulativeStack: 200, cumulativeBounded: false,
                 depth: 2, callees: [], callers: ["app_main"], indirect: [],
                 perRoot: [{ rootName: "app_main", depth: 2, entry: 192, cumulativeStack: 200 }] }],
]);
const state = {
  byName, depth: byName, pinnedRoots: new Set(["app_main"]),
  thresholdWarn: 1024, thresholdCritical: 4096, pathsLimit: 5, pathsMaxDepth: 32,
};

// --- Instantiate the provider and grab its HTML. -----------------------------
const deps = {
  getState: () => state,
  onQuery: () => {},
  log: { info(){}, warn(){}, error(){} },
};
const provider = new SidePanelProvider(deps);

const fakeWebview = { cspSource: "vscode-resource:", asWebviewUri: (u) => u,
  options: {}, onDidReceiveMessage: () => ({ dispose(){} }), postMessage: () => {} };
const html = provider.getHtml(fakeWebview);

// --- Capture the messages the extension would push on "ready". ---------------
const outbound = []; // messages the webview posts to the extension
let webviewState = undefined; // emulates VS Code's retained webview state
function deliverAnalysis(dom) {
  // Mimic notifyAnalysisUpdated(): names, state, top, recursion.
  const names = ["app_main", "worker"];
  const post = (m) => dom.window.dispatchEvent(new dom.window.MessageEvent("message", { data: m }));
  post({ type: "names", names });
  post({ type: "state", summary: { total: names.length, withStack: 2 },
         thresholds: { warn: 1024, critical: 4096 }, pathsLimit: 5 });
  post({ type: "top", entries: [
    { name: "app_main", file: "/proj/src/app/main.c", peak: 4800, bounded: false, recursive: false, recursiveViaFp: false, pinnedRoot: true, autoRoot: false },
    { name: "worker", file: "/proj/src/drivers/worker.c", peak: 200, bounded: false, recursive: false, recursiveViaFp: false, pinnedRoot: false, autoRoot: false }] });
  post({ type: "unboundFp", entries: [
    { name: "dispatch_isr", file: "drivers.c", sites: 1, peak: 1344 }] });
  post({ type: "recursion", entries: [] });
}

// Track query→result and the auto-refresh re-query after a new analysis round.
let queryCount = 0;
let autoRefreshRequery = false;
let secondRoundDone = false;

function sendResult(dom, name) {
  const post = (m) => dom.window.dispatchEvent(new dom.window.MessageEvent("message", { data: m }));
  post({ type: "result", payload: {
    name, file: "app.c", nameLine: 8, recursive: false, recursiveViaFp: false,
    fpVerified: false, pinnedRoot: true, autoRoot: false, depth: 1,
    stackBytes: 128, cumulativeStack: 4800, cumulativeBounded: false,
    perRoot: [{ rootName: name, rootIsPinned: true, depth: 1, cumulativeStack: 4800 }],
    outgoing: [], incoming: [], cycles: [], outgoingTotal: 0, incomingTotal: 0,
    pathCap: 500, thresholdWarn: 1024, thresholdCritical: 4096
  }});
}

// --- Run the HTML in jsdom with the inline script executing. -----------------
const dom = new JSDOM(html, {
  runScripts: "dangerously",
  beforeParse(window) {
    window.acquireVsCodeApi = () => ({
      postMessage: (m) => {
        outbound.push(m);
        if (m && m.type === "ready") {
          setTimeout(() => deliverAnalysis(dom), 0);
        } else if (m && m.type === "query") {
          queryCount++;
          // The 2nd+ query that arrives WITHOUT a user action (i.e. right after
          // a fresh analysis round) is the auto-refresh re-query we added.
          if (secondRoundDone) autoRefreshRequery = true;
          setTimeout(() => sendResult(dom, m.name), 0);
        }
      },
      getState: () => webviewState, setState: (s) => { webviewState = s; },
    });
  },
});

// --- Assert after the event loop drains. -------------------------------------
setTimeout(() => {
  const doc = dom.window.document;
  const status = doc.getElementById("status");
  const summary = doc.getElementById("summary");
  const statusText = status ? status.textContent.trim() : "(no #status)";
  const statusVisible = status && status.style.display !== "none";
  const summaryText = summary ? summary.textContent.trim() : "(no #summary)";
  const summaryVisible = summary && summary.style.display !== "none";

  console.log("posted by webview:", JSON.stringify(outbound));
  console.log("#status:", JSON.stringify(statusText), "visible:", statusVisible);
  console.log("#summary:", JSON.stringify(summaryText), "visible:", summaryVisible);

  const ranScript = outbound.some((m) => m && m.type === "ready") || statusText !== "Loading analysis…";
  const rendered = summaryVisible && /\bfn\b/.test(summaryText) && !statusVisible;
  if (!ranScript) {
    console.log("RESULT: FAIL — inline script never ran (still on Loading…).");
    process.exit(1);
  }
  if (!rendered) {
    console.log("RESULT: FAIL — script ran but panel did not render analysis.");
    process.exit(2);
  }
  console.log("RESULT: PASS — script ran, ready sent, analysis rendered.");

  // --- Unbound-fp panel section must appear when unboundFp entries are sent.
  const unboundBlock = doc.getElementById("unbound-block");
  const unboundShown = unboundBlock && unboundBlock.style.display !== "none";
  const unboundText = doc.getElementById("unbound") ? doc.getElementById("unbound").textContent : "";
  console.log("unbound-fp shown:", unboundShown, "| has dispatch_isr:", /dispatch_isr/.test(unboundText));
  if (!unboundShown || !/dispatch_isr/.test(unboundText)) {
    console.log("RESULT: FAIL — unbound-fp section did not render.");
    process.exit(5);
  }
  console.log("UNBOUND-FP: PASS — functions with unbound fp call sites are listed.");

  // --- Top-by-peak path filter: typing a path narrows the list to matches and
  //     shows the (highlighted) path; clearing restores the full list. --------
  const topFilter = doc.getElementById("top-filter");
  const topDiv = doc.getElementById("top");
  if (!topFilter) {
    console.log("RESULT: FAIL — top path filter input missing.");
    process.exit(6);
  }
  topFilter.value = "drivers";
  topFilter.dispatchEvent(new dom.window.Event("input"));
  const afterFilter = topDiv.querySelectorAll("[data-top]").length;
  const hasPath = !!topDiv.querySelector(".top-path");
  const hasHighlight = !!topDiv.querySelector(".top-path b");
  console.log("top filter 'drivers' rows:", afterFilter, "| path shown:", hasPath, "| highlighted:", hasHighlight);
  if (afterFilter !== 1 || !hasPath || !hasHighlight) {
    console.log("RESULT: FAIL — top path filter did not narrow/annotate correctly.");
    process.exit(6);
  }
  topFilter.value = "/proj/src/app/main.c";
  topFilter.dispatchEvent(new dom.window.Event("input"));
  const absMatch = topDiv.querySelectorAll("[data-top]").length;
  topFilter.value = "";
  topFilter.dispatchEvent(new dom.window.Event("input"));
  const restored = topDiv.querySelectorAll("[data-top]").length;
  console.log("absolute-path filter rows:", absMatch, "| cleared rows:", restored);
  if (absMatch !== 1 || restored !== 2) {
    console.log("RESULT: FAIL — top path filter absolute/clear behavior wrong.");
    process.exit(6);
  }
  console.log("TOP-FILTER: PASS — Top-by-peak filters by absolute path and name.");

  // --- Recursive & Unbound sections also filter by absolute path. -----------
  dom.window.dispatchEvent(new dom.window.MessageEvent("message", { data: { type: "recursion", entries: [
    { name: "rec_drv", file: "/proj/src/drivers/r.c", viaFp: false, peak: 500, hops: 1 },
    { name: "rec_mod", file: "/proj/src/modules/r.c", viaFp: true, peak: 300, hops: 3 }
  ] } }));
  dom.window.dispatchEvent(new dom.window.MessageEvent("message", { data: { type: "unboundFp", entries: [
    { name: "ub_drv", file: "/proj/src/drivers/u.c", sites: 1, peak: 400 },
    { name: "ub_mod", file: "/proj/src/modules/u.c", sites: 2, peak: 200 }
  ] } }));
  const recFilter = doc.getElementById("rec-filter");
  const unboundFilter = doc.getElementById("unbound-filter");
  if (!recFilter || !unboundFilter) {
    console.log("RESULT: FAIL — recursive/unbound filter inputs missing.");
    process.exit(8);
  }
  recFilter.value = "drivers";
  recFilter.dispatchEvent(new dom.window.Event("input"));
  const recRows = doc.getElementById("rec").querySelectorAll("[data-top]").length;
  const recPath = !!doc.getElementById("rec").querySelector(".top-path b");
  unboundFilter.value = "modules";
  unboundFilter.dispatchEvent(new dom.window.Event("input"));
  const ubRows = doc.getElementById("unbound").querySelectorAll("[data-top]").length;
  console.log("recursive filter 'drivers' rows:", recRows, "| path highlighted:", recPath,
              "| unbound filter 'modules' rows:", ubRows);
  if (recRows !== 1 || !recPath || ubRows !== 1) {
    console.log("RESULT: FAIL — recursive/unbound path filter did not work.");
    process.exit(8);
  }
  console.log("LIST-FILTERS: PASS — recursive & unbound lists filter by absolute path.");

  // --- State persistence: opening a function records it in the webview's
  //     retained state, so switching sidebar views and back can restore it. ---
  // Open a function by delivering a result, then check it was persisted.
  dom.window.dispatchEvent(new dom.window.MessageEvent("message", { data: {
    type: "result", payload: {
      name: "app_main", file: "main.c", nameLine: 1, recursive: false,
      recursiveViaFp: false, fpVerified: false, pinnedRoot: false, autoRoot: false,
      depth: 1, stackBytes: 64, cumulativeStack: 900, cumulativeBounded: false,
      perRoot: [
        { rootName: "root_drv", rootFile: "/proj/src/drivers/main.c", rootIsPinned: true, isAuto: false, depth: 3, cumulativeStack: 900, cumulativeBounded: false },
        { rootName: "root_mod", rootFile: "/proj/src/modules/init.c", rootIsPinned: false, isAuto: true, depth: 2, cumulativeStack: 500, cumulativeBounded: false }
      ],
      outgoing: [], incoming: [], cycles: [], outgoingTotal: 0,
      incomingTotal: 0, pathCap: 500, thresholdWarn: 1024, thresholdCritical: 4096, fpSites: []
    }
  } }));
  const savedFn = webviewState && webviewState.openFn;
  console.log("persisted open function:", JSON.stringify(savedFn));
  if (savedFn !== "app_main") {
    console.log("RESULT: FAIL — open function was not persisted to webview state.");
    process.exit(7);
  }
  console.log("PERSIST: PASS — the open function is saved for restore across view switches.");

  // --- Per-root table also filters by absolute path. ------------------------
  const prFilter = doc.getElementById("per-root-filter");
  if (!prFilter) {
    console.log("RESULT: FAIL — per-root filter input missing.");
    process.exit(9);
  }
  prFilter.value = "drivers";
  prFilter.dispatchEvent(new dom.window.Event("input"));
  const prRows = doc.querySelectorAll(".per-root-tbl tbody tr").length;
  const prPath = !!doc.querySelector(".per-root-tbl .top-path b");
  console.log("per-root filter 'drivers' rows:", prRows, "| path highlighted:", prPath);
  if (prRows !== 1 || !prPath) {
    console.log("RESULT: FAIL — per-root path filter did not work.");
    process.exit(9);
  }
  console.log("PER-ROOT-FILTER: PASS — per-root table filters by absolute path.");

  // --- Per-root table must not overflow the panel: fixed layout + colgroup so
  //     long root names / paths are constrained, not pushing the table wide. --
  const prTable = doc.querySelector(".per-root-tbl");
  const cols = prTable ? prTable.querySelectorAll("colgroup col").length : 0;
  const fixed = !!(prTable && /table-layout:\s*fixed/.test(html));
  console.log("per-root table-layout fixed:", fixed, "| colgroup cols:", cols);
  if (!prTable || cols !== 4 || !fixed) {
    console.log("RESULT: FAIL — per-root table is not constrained (could overflow).");
    process.exit(12);
  }
  console.log("PER-ROOT-LAYOUT: PASS — per-root table is width-constrained (no overflow).");

  // --- Top list shows each function's call depth; recursion list shows each
  //     cycle's hop count. -----------------------------------------------------
  // Clear any active list filters first so all rows render.
  const recFilterEl = doc.getElementById("rec-filter");
  const topFilterEl = doc.getElementById("top-filter");
  if (recFilterEl) { recFilterEl.value = ""; recFilterEl.dispatchEvent(new dom.window.Event("input")); }
  if (topFilterEl) { topFilterEl.value = ""; topFilterEl.dispatchEvent(new dom.window.Event("input")); }
  const topText = doc.getElementById("top").textContent;
  const recText = doc.getElementById("rec").textContent;
  const topHasNoDepth = !/depth \d/.test(topText);   // depth was removed from Top
  const recHasHops = /self/.test(recText) && /3 hops/.test(recText);
  console.log("top has no depth label:", topHasNoDepth, "| recursion shows hops:", recHasHops);
  if (!topHasNoDepth || !recHasHops) {
    console.log("RESULT: FAIL — depth/hop annotations not as expected.");
    process.exit(13);
  }
  console.log("DEPTH-HOPS: PASS — Recursive shows cycle hop count; Top has no depth label.");

  // --- Tab separation: overview lists live in the Overview tab; opening a
  //     function switches to the Function tab. -------------------------------
  const tabFn = doc.getElementById("tab-function");
  const tabOv = doc.getElementById("tab-overview");
  const fnPanel = doc.getElementById("function-tab");
  const ovPanel = doc.getElementById("overview-tab");
  const topBlk = doc.getElementById("top-block");
  if (!tabFn || !tabOv || !fnPanel || !ovPanel) {
    console.log("RESULT: FAIL — tab structure missing.");
    process.exit(10);
  }
  const overviewHoldsTop = ovPanel.contains(topBlk);
  // After opening app_main above, the Function tab should be the active one.
  const fnActiveAfterOpen = fnPanel.style.display !== "none" && tabFn.classList.contains("active");
  // Clicking Overview shows the overview panel and hides the function panel.
  tabOv.dispatchEvent(new dom.window.Event("click"));
  const ovShown = ovPanel.style.display !== "none" && fnPanel.style.display === "none";
  const ovBadge = /tab-badge/.test(tabOv.innerHTML);
  console.log("overview holds top-block:", overviewHoldsTop, "| function tab active after open:", fnActiveAfterOpen,
              "| overview shows on click:", ovShown, "| overview badge:", ovBadge);
  if (!overviewHoldsTop || !fnActiveAfterOpen || !ovShown || !ovBadge) {
    console.log("RESULT: FAIL — tab separation did not behave as expected.");
    process.exit(10);
  }
  console.log("TABS: PASS — overview lists and per-function detail are in separate tabs.");

  // --- After a function opens, the autocomplete dropdown must be closed (so it
  //     doesn't linger over the detail view, e.g. after an Overview click). ---
  const sugg = doc.getElementById("suggestions");
  const qbox = doc.getElementById("q");
  // Force the dropdown open as if the user were typing, then open a function
  // (as an Overview click does: set q.value + deliver a result) and confirm the
  // dropdown closed.
  if (qbox) { qbox.value = "app"; qbox.dispatchEvent(new dom.window.Event("input")); }
  const suggWasOpen = sugg && sugg.style.display !== "none";
  dom.window.dispatchEvent(new dom.window.MessageEvent("message", { data: {
    type: "result", payload: {
      name: "app_main", file: "main.c", nameLine: 1, recursive: false,
      recursiveViaFp: false, fpVerified: false, pinnedRoot: false, autoRoot: false,
      depth: 1, stackBytes: 64, cumulativeStack: 900, cumulativeBounded: false,
      perRoot: [], outgoing: [], incoming: [], cycles: [], outgoingTotal: 0,
      incomingTotal: 0, pathCap: 500, thresholdWarn: 1024, thresholdCritical: 4096, fpSites: []
    }
  } }));
  const suggClosed = sugg && sugg.style.display === "none";
  console.log("suggestions was open:", suggWasOpen, "| closed after opening a function:", suggClosed);
  if (!suggClosed) {
    console.log("RESULT: FAIL — autocomplete dropdown stayed open over the detail view.");
    process.exit(11);
  }
  console.log("SUGGEST-CLOSE: PASS — autocomplete closes when a function opens.");

  // --- Hover test: the editor HoverProvider must return stack markdown when
  //     the cursor is on a function's definition name. -----------------------
  let hoverOk = false;
  try {
    const { makeHoverProvider } = require("../out/displayProviders.js");
    // DisplayState shape used by the provider: byFile, depth, pinnedRoots.
    const recApp = { name: "app_main", file: "app.c", nameLine: 8, stackBytes: 128,
                     ghost: false, callees: ["worker"], stackQualifier: "" };
    const hoverState = {
      byFile: new Map([["app.c", [recApp]]]),
      depth: byName,                       // reuse the DepthInfo map built above
      pinnedRoots: new Set(["app_main"]),
      byName,
    };
    const provider = makeHoverProvider(() => hoverState, () => ({ mode: "hover", thresholdWarn: 1024, thresholdCritical: 4096 }));
    // Fake document: cursor on the "app_main" token at its definition line.
    const fakeDoc = {
      uri: { fsPath: "app.c" },
      getWordRangeAtPosition: (pos) => ({ start: pos, end: pos }),
      getText: () => "app_main",
    };
    const pos = { line: 8, character: 4 };
    const hover = provider.provideHover(fakeDoc, pos);
    const md = hover && hover.contents && hover.contents[0];
    const text = md ? (md.value || "") : "";
    console.log("hover content has name:", /app_main/.test(text), "| length:", text.length);
    hoverOk = !!hover && /app_main/.test(text) && text.length > 0;
  } catch (e) {
    console.log("hover test error:", e.message);
  }
  if (!hoverOk) {
    console.log("RESULT: FAIL — hover provider did not return content.");
    process.exit(3);
  }
  console.log("HOVER: PASS — provideHover returned stack markdown for the function under the cursor.");

  // --- Auto-refresh test: open a function, then push a NEW analysis round and
  //     verify the panel re-queries the open function automatically. ----------
  const post = (m) => dom.window.dispatchEvent(new dom.window.MessageEvent("message", { data: m }));
  // 1) User opens a function (externalQuery → webview sends query → we reply).
  post({ type: "externalQuery", name: "app_main" });
  setTimeout(() => {
    const queriesAfterOpen = queryCount;
    // 2) A file change triggers a fresh analysis round (names/state/top/recursion).
    secondRoundDone = true;
    deliverAnalysis(dom);
    setTimeout(() => {
      // The recursion message (end of the round) should have caused the webview
      // to auto re-query the currently-open function — without any user action.
      if (autoRefreshRequery && queryCount > queriesAfterOpen) {
        console.log("AUTO-REFRESH: PASS — open function re-queried after new analysis (" +
          queriesAfterOpen + " → " + queryCount + " queries).");
        process.exit(0);
      } else {
        console.log("AUTO-REFRESH: FAIL — open function was not re-queried after analysis update.");
        process.exit(4);
      }
    }, 100);
  }, 100);
}, 200);
