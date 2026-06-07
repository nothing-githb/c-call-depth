// src/graphView.ts
// An interactive call-hierarchy graph, shown as a full editor-area webview
// panel (distinct from the narrow side panel). Renders a bounded
// neighborhood around a focus function as a layered node-link diagram:
// callers fan out to the left, callees to the right, focus in the middle.
//
// Interactions (handled in the webview, posted back to the host):
//   - click a node      → refocus the graph on it
//   - double-click node → open its source
//   - depth sliders     → expand/contract how many caller/callee hops show
//   - severity coloring  by peak stack; indirect (fp) edges marked

import * as vscode from "vscode";
import {
  FunctionRecord, DepthInfo, GraphData, neighborhood
} from "./callGraph";

export interface GraphViewDeps {
  getState: () => {
    byName: Map<string, FunctionRecord>;
    depth: Map<string, DepthInfo>;
    pinnedRoots: Set<string>;
    thresholdWarn: number;
    thresholdCritical: number;
  };
  /** Open a function's source location. */
  openFunction: (name: string) => void;
  /** Show a function's full stack breakdown (e.g. in the side panel). */
  showStack: (name: string) => void;
  /** Optional: log a message from the webview to the extension output. */
  log?: (msg: string) => void;
}

export class GraphView {
    static viewType = "cCallDepth.graph";
    private deps: GraphViewDeps;
    private upHops: number;
    private downHops: number;
    private focus?: string;
    private panel?: vscode.WebviewPanel;
    private pendingHighlight?: string;
    constructor(deps: GraphViewDeps) {
        this.deps = deps;
        this.upHops = 2;
        this.downHops = 2;
    }
    /** Open (or reveal) the panel, focused on `name`. */
    show(name?: string, opts?: { fromRoot?: string; depthHint?: number }) {
        if (name)
            this.focus = name;
        // "View per-root path in graph": focus the ROOT and open callees deep enough
        // to reach the target function, so the root→…→fn path is visible. Callers
        // (up) are hidden since we're looking downward from the entry point.
        if (opts && opts.fromRoot) {
            this.focus = opts.fromRoot;
            this.upHops = 0;
            const d = (typeof opts.depthHint === "number" && opts.depthHint > 0) ? opts.depthHint : 6;
            // depthHint is the target's depth from this root (root = depth 1), so the
            // number of hops down is depth-1; clamp to a sane range.
            this.downHops = Math.max(1, Math.min(20, d - 1 || 1));
            this.pendingHighlight = name; // emphasize the target on render
        }
        if (!this.panel) {
            this.panel = vscode.window.createWebviewPanel(GraphView.viewType, "Call Graph", vscode.ViewColumn.Active, { enableScripts: true, retainContextWhenHidden: true });
            this.panel.webview.html = this.getHtml();
            this.panel.onDidDispose(() => { this.panel = undefined; });
            this.panel.webview.onDidReceiveMessage(msg => this.onMessage(msg));
        }
        else {
            this.panel.reveal(vscode.ViewColumn.Active);
        }
        this.pushData();
    }
    /** Re-render if the panel is open (e.g. after a fresh analysis). */
    refresh() {
        if (this.panel)
            this.pushData();
    }
    onMessage(msg) {
        if (!msg || typeof msg !== "object")
            return;
        switch (msg.type) {
            case "ready":
                this.pushData();
                break;
            case "clientError": {
                const parts = [msg.message];
                if (msg.source)
                    parts.push("@ " + msg.source + ":" + (msg.line ?? "?") + ":" + (msg.col ?? "?"));
                if (msg.stack)
                    parts.push("\n" + msg.stack);
                this.deps.log?.(parts.join(" "));
                break;
            }
            case "requestNames": {
                // Webview asked for the symbol list (its copy was empty). Send the
                // current names directly so the search box can offer suggestions even
                // if no graph push has carried them yet.
                const st = this.deps.getState();
                const ns = [];
                for (const [name, rec] of st.byName)
                    if (!rec.ghost)
                        ns.push(name);
                ns.sort();
                this.panel?.webview.postMessage({ type: "names", names: ns });
                break;
            }
            case "refocus":
                if (typeof msg.name === "string") {
                    this.focus = msg.name;
                    this.pushData();
                }
                break;
            case "open":
                if (typeof msg.name === "string")
                    this.deps.openFunction(msg.name);
                break;
            case "stack":
                if (typeof msg.name === "string")
                    this.deps.showStack(msg.name);
                break;
            case "setHops":
                // No upper hop limit: depth is effectively unbounded. The actual graph
                // is kept safe by a node budget in neighborhood() (which marks
                // truncation), so a deep/dense expansion can't freeze the host.
                if (typeof msg.up === "number")
                    this.upHops = Math.max(0, msg.up);
                if (typeof msg.down === "number")
                    this.downHops = Math.max(0, msg.down);
                this.pushData();
                break;
        }
    }
    pushData() {
        if (!this.panel)
            return;
        const state = this.deps.getState();
        // Full symbol list for the search box — always sent (even when there is no
        // focus yet), so the "focus function…" box can offer suggestions exactly
        // like the side panel's lookup, before anything is focused.
        const allNames = [];
        for (const [name, rec] of state.byName)
            if (!rec.ghost)
                allNames.push(name);
        allNames.sort();
        // Pick a sensible default focus if none chosen yet: the highest-peak
        // function (most interesting starting point).
        if (!this.focus || !state.byName.has(this.focus)) {
            let best;
            let bestPeak = -1;
            for (const [name, rec] of state.byName) {
                if (rec.ghost)
                    continue;
                const info = state.depth.get(name);
                const peak = info?.cumulativeStack ?? -1;
                if (peak > bestPeak) {
                    bestPeak = peak;
                    best = name;
                }
            }
            this.focus = best;
        }
        if (!this.focus) {
            this.panel.webview.postMessage({ type: "graph", data: { focus: "", nodes: [], edges: [] }, names: allNames });
            return;
        }
        const recursiveSet = new Set<string>();
        for (const [name, info] of state.depth)
            if (info.recursive)
                recursiveSet.add(name);
        const data = neighborhood(state.byName, state.depth, this.focus, this.upHops, this.downHops, recursiveSet, state.pinnedRoots);
        this.panel.webview.postMessage({
            type: "graph",
            data,
            focus: this.focus,
            upHops: this.upHops,
            downHops: this.downHops,
            thresholds: { warn: state.thresholdWarn, critical: state.thresholdCritical },
            names: allNames,
            highlight: this.pendingHighlight
        });
        this.pendingHighlight = undefined;
    }
    getHtml() {
        return exports.GRAPH_HTML;
    }
}
function clamp(n, lo, hi) {
    return Math.max(lo, Math.min(hi, n));
}
// The webview content. Self-contained SVG renderer with a layered layout,
// pan/zoom, and a search box. No external libraries.
export const GRAPH_HTML = String.raw `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<style>
  :root { color-scheme: light dark; }
  * { box-sizing: border-box; }
  body {
    margin: 0; padding: 0; overflow: hidden;
    font-family: var(--vscode-font-family);
    color: var(--vscode-foreground);
    background: var(--vscode-editor-background);
  }
  #toolbar {
    position: fixed; top: 0; left: 0; right: 0; height: 40px;
    display: flex; align-items: center; gap: 12px; padding: 0 12px;
    background: var(--vscode-editorWidget-background, var(--vscode-editor-background));
    border-bottom: 1px solid var(--vscode-panel-border);
    z-index: 10; overflow: visible;
  }
  #toolbar input[type="text"] {
    width: 220px; padding: 4px 8px;
    background: var(--vscode-input-background);
    color: var(--vscode-input-foreground);
    border: 1px solid var(--vscode-input-border, var(--vscode-panel-border));
    border-radius: 4px; font-size: 12px;
  }
  .hop-ctl { display: flex; align-items: center; gap: 4px; font-size: 11px;
    color: var(--vscode-descriptionForeground); }
  .hop-ctl button {
    width: 22px; height: 22px; border-radius: 4px; cursor: pointer;
    background: transparent; color: var(--vscode-foreground);
    border: 1px solid var(--vscode-panel-border); font-size: 13px; line-height: 1;
  }
  .hop-ctl button:hover { background: var(--vscode-list-hoverBackground); }
  .hop-ctl .val { min-width: 14px; text-align: center; font-variant-numeric: tabular-nums;
    color: var(--vscode-foreground); }
  #legend { margin-left: auto; display: flex; gap: 10px; font-size: 11px;
    color: var(--vscode-descriptionForeground); align-items: center; }
  .legend-dot { display: inline-block; width: 9px; height: 9px; border-radius: 2px;
    margin-right: 3px; vertical-align: middle; }
  .legend-line { display: inline-block; width: 14px; height: 2px;
    margin-right: 3px; vertical-align: middle; }
  #canvas { position: fixed; top: 40px; left: 0; width: 100vw; height: calc(100vh - 40px);
    cursor: grab; display: block; }
  #canvas.grabbing { cursor: grabbing; }
  #hint { position: fixed; bottom: 8px; left: 12px; font-size: 11px;
    color: var(--vscode-descriptionForeground); pointer-events: none; }
  /* Clicking a node flashes the hint to point the user at "right-click for actions". */
  @keyframes hint-blink {
    0%, 100% { color: var(--vscode-descriptionForeground); opacity: 0.85; }
    25%, 75% { color: var(--vscode-charts-blue, #4aa3ff); opacity: 1; }
    50% { opacity: 0.35; }
  }
  #hint.blink { animation: hint-blink 0.85s ease-in-out 2; }
  #budget-note { position: fixed; top: 40px; right: 12px; z-index: 5;
    max-width: 320px; padding: 6px 10px; font-size: 11px; border-radius: 4px;
    background: var(--vscode-inputValidation-warningBackground, rgba(212,170,60,0.2));
    border: 1px solid var(--vscode-inputValidation-warningBorder, #d4aa3c);
    color: var(--vscode-foreground); }
  .search-wrap { position: relative; display: inline-block; }
  #suggest {
    position: fixed; max-height: 260px; overflow-y: auto; z-index: 9999; display: none;
    background: var(--vscode-dropdown-background, var(--vscode-editorWidget-background, var(--vscode-editor-background)));
    border: 1px solid var(--vscode-dropdown-border, var(--vscode-panel-border));
    border-radius: 4px; box-shadow: 0 4px 12px rgba(0,0,0,0.4);
  }
  .sug-item { padding: 4px 8px; font-size: 12px; cursor: pointer;
    color: var(--vscode-dropdown-foreground, var(--vscode-foreground));
    font-family: var(--vscode-editor-font-family); white-space: nowrap; }
  .sug-item.active, .sug-item:hover { background: var(--vscode-list-activeSelectionBackground, var(--vscode-list-hoverBackground));
    color: var(--vscode-list-activeSelectionForeground, inherit); }
  .sug-hit { font-weight: 700; text-decoration: underline; }
  @keyframes pulseTarget { 0%,100% { stroke-width: 2; } 50% { stroke-width: 6; } }
  .pulse-target .node-rect { animation: pulseTarget 0.6s ease-in-out 0s 3;
    stroke: var(--vscode-charts-blue, #4aa3ff) !important; }
  .node-rect { cursor: pointer; }
  .node-label { font-family: var(--vscode-editor-font-family); font-size: 11px;
    pointer-events: none; }
  .node-sub { font-size: 9px; opacity: 0.75; pointer-events: none; }
  .edge { fill: none; stroke: var(--vscode-panel-border); stroke-width: 1.2; }
  /* Halo underlay: wider, editor-background colored, drawn under each edge so
     the line stays legible where it crosses a node box or another edge. */
  .edge-halo { fill: none; stroke: var(--vscode-editor-background); stroke-width: 4.5;
    stroke-linecap: round; }
  .edge-halo.cross { opacity: 0.22; }
  .edge.indirect { stroke-dasharray: 4 3; }
  /* Manually bound (verified) fp edge: exact, not over-approximated. Solid
     green so it reads as "confirmed" vs the dashed over-approximated fp edge. */
  .edge.fp-verified { stroke: var(--vscode-charts-green, #2ea043); stroke-dasharray: none; stroke-width: 1.8; }
  .edge.cross { opacity: 0.22; stroke-dasharray: 2 4; }
  .edge-arrow.cross { opacity: 0.22; }
  .edge-arrow { fill: var(--vscode-panel-border); }
  /* Hover path highlighting */
  .node-rect, .edge, .edge-arrow, .node-label, .node-sub { transition: opacity 0.12s; }
  g.dimmed { opacity: 0.18; }
  g.hl-node .node-rect { stroke-width: 3; }
  .edge.edge-hl { stroke: var(--vscode-charts-blue, #4aa3ff); stroke-width: 2; opacity: 1; }
  .edge-arrow.edge-hl { fill: var(--vscode-charts-blue, #4aa3ff); opacity: 1; }
  .edge.edge-dim { opacity: 0.1; }
  .edge-arrow.edge-dim { opacity: 0.1; }
  .edge-halo.edge-dim { opacity: 0.05; }
  .file-frame { fill-opacity: 0.06; stroke-width: 1.2; stroke-dasharray: 6 4; }
  .file-frame-label { font-family: var(--vscode-editor-font-family); font-size: 11px;
    font-weight: 600; opacity: 0.85; pointer-events: none; }
  .empty-msg { position: fixed; top: 50%; left: 50%; transform: translate(-50%,-50%);
    color: var(--vscode-descriptionForeground); font-size: 13px; text-align: center; }
  #ctxmenu {
    position: fixed; z-index: 50; display: none; min-width: 200px;
    background: var(--vscode-menu-background, var(--vscode-dropdown-background, var(--vscode-editor-background)));
    color: var(--vscode-menu-foreground, var(--vscode-foreground));
    border: 1px solid var(--vscode-menu-border, var(--vscode-panel-border));
    border-radius: 6px; padding: 4px; box-shadow: 0 4px 14px rgba(0,0,0,0.35);
    font-size: 12px;
  }
  #ctxmenu .ctx-head {
    padding: 5px 10px 6px; font-family: var(--vscode-editor-font-family);
    font-weight: 600; border-bottom: 1px solid var(--vscode-panel-border);
    margin-bottom: 4px; max-width: 280px; overflow: hidden; text-overflow: ellipsis;
    white-space: nowrap;
  }
  #ctxmenu .ctx-item {
    padding: 6px 10px; border-radius: 4px; cursor: pointer;
    display: flex; align-items: center; gap: 8px;
  }
  #ctxmenu .ctx-item:hover {
    background: var(--vscode-menu-selectionBackground, var(--vscode-list-activeSelectionBackground));
    color: var(--vscode-menu-selectionForeground, var(--vscode-list-activeSelectionForeground));
  }
  #ctxmenu .ctx-item.disabled { opacity: 0.4; cursor: default; }
  #ctxmenu .ctx-item.disabled:hover { background: transparent; color: inherit; }
  #ctxmenu .ctx-key { margin-left: auto; opacity: 0.6; font-size: 11px; }
  #ctxmenu .ctx-sep { height: 1px; background: var(--vscode-panel-border); margin: 4px 0; }
  #ctxmenu .ctx-info {
    padding: 4px 10px; color: var(--vscode-descriptionForeground); font-size: 11px;
    font-family: var(--vscode-editor-font-family);
  }
</style>
</head>
<body>
  <div id="toolbar">
    <div class="search-wrap">
      <input id="search" type="text" placeholder="focus function…" autocomplete="off" />
      <div id="suggest"></div>
    </div>
    <div class="hop-ctl">callers
      <button data-up="-1">−</button><span class="val" id="up-val">2</span><button data-up="1">+</button>
    </div>
    <div class="hop-ctl">callees
      <button data-down="-1">−</button><span class="val" id="down-val">2</span><button data-down="1">+</button>
    </div>
    <label class="hop-ctl" style="cursor:pointer">
      <input type="checkbox" id="group-files" style="margin:0 4px 0 0" />file groups
    </label>
    <div id="legend">
      <span><span class="legend-dot" style="background:#4caf50"></span>ok</span>
      <span><span class="legend-dot" style="background:#ffa726"></span>warn</span>
      <span><span class="legend-dot" style="background:#ef5350"></span>critical</span>
      <span><span class="legend-dot" style="background:#888"></span>no stack</span>
      <span><span class="legend-line" style="background:var(--vscode-charts-green,#2ea043)"></span>fp bound ✓</span>
      <span><span class="legend-line" style="background:var(--vscode-descriptionForeground);border-top:2px dashed"></span>fp (over-approx)</span>
      <span>📌/⚓ root</span>
      <span><span class="legend-line" style="background:var(--vscode-descriptionForeground);opacity:0.4"></span>cross edge</span>
    </div>
  </div>
  <div id="budget-note" style="display:none"></div>
  <svg id="canvas"><g id="viewport"></g></svg>
  <div id="ctxmenu"></div>
  <div id="hint">drag to pan · scroll to zoom · hover a node to trace paths · right-click for actions</div>

<script>
  const vscode = acquireVsCodeApi();
  // Report any uncaught error in this webview back to the extension's output
  // channel, so problems that only happen in the real VS Code webview (not in
  // tests) are visible without opening the webview devtools.
  window.addEventListener('error', (e) => {
    try {
      vscode.postMessage({ type: 'clientError',
        message: (e && e.message) ? e.message : String(e),
        source: e && e.filename, line: e && e.lineno, col: e && e.colno,
        stack: e && e.error && e.error.stack });
    } catch (_) {}
  });
  window.addEventListener('unhandledrejection', (e) => {
    try {
      vscode.postMessage({ type: 'clientError',
        message: 'unhandledrejection: ' + ((e && e.reason && e.reason.message) || String(e && e.reason)),
        stack: e && e.reason && e.reason.stack });
    } catch (_) {}
  });

  // Run everything below only once the DOM is parsed. In the real VS Code
  // webview the script can occasionally execute before <body> is ready, which
  // made document.getElementById(...) return null and broke all wiring
  // (including the search box). Deferring to DOMContentLoaded fixes that.
  function boot() {
  let svg = document.getElementById('canvas');
  let viewport = document.getElementById('viewport');
  let search = document.getElementById('search');
  let suggest = document.getElementById('suggest');
  const SVGNS = 'http://www.w3.org/2000/svg';
  // Version + element sanity beacon. If you ever see a stale webview, this tells
  // you exactly which build is running and whether #suggest exists.
  const BUILD = 'graph v1.0.3';
  try { console.log('[c-call-depth] ' + BUILD + ' boot; search=' + !!search + ' suggest=' + !!suggest + ' canvas=' + !!svg); } catch (_) {}
  function resolveEls() {
    svg = svg || document.getElementById('canvas');
    viewport = viewport || document.getElementById('viewport');
    search = search || document.getElementById('search');
    suggest = suggest || document.getElementById('suggest');
  }
  resolveEls();
  // Move the suggestion dropdown to <body> so no toolbar/wrap stacking context
  // can clip or hide it; it's positioned in viewport coords by positionSuggest.
  if (suggest && suggest.parentElement !== document.body) {
    document.body.appendChild(suggest);
  }
  if (!search || !suggest || !svg) {
    try {
      vscode.postMessage({ type: 'clientError',
        message: 'elements missing even after DOM ready: search=' + !!search +
                 ' suggest=' + !!suggest + ' canvas=' + !!svg +
                 ' readyState=' + document.readyState });
    } catch (_) {}
  }

  let names = [];
  let thresholds = { warn: 1024, critical: 4096 };
  let current = { focus: '', nodes: [], edges: [] };
  let view = { x: 0, y: 0, k: 1 };   // pan x/y, zoom k
  let sugMatches = [], sugActive = -1;
  let lastQuery = '';
  // Rendered element registries for hover highlighting.
  let nodeEls = new Map();   // name -> <g>
  let edgeEls = [];          // { from, to, path, arrow }

  // ── Search box wiring — bound FIRST, before any graph-rendering code, so a
  // later error in the (more complex) graph code can never prevent the search
  // box from working. Wrapped in a function so it can also be (re)run after
  // DOMContentLoaded if the script happened to run before the DOM was parsed.
  let searchWired = false;
  function wireSearch() {
    if (searchWired || !search) return;
    searchWired = true;
    search.addEventListener('input', runSearch);
    search.addEventListener('focus', runSearch);
    search.addEventListener('click', runSearch);
    search.addEventListener('mouseup', runSearch);
    search.addEventListener('keydown', (e) => {
      const count = sugMatches.length;
      if (e.key === 'ArrowDown') { if (count) { e.preventDefault();
        sugActive = sugActive < 0 ? 0 : (sugActive + 1) % count; refreshActive(); } else { runSearch(); } }
      else if (e.key === 'ArrowUp' && count) { e.preventDefault();
        sugActive = sugActive <= 0 ? count - 1 : sugActive - 1; refreshActive(); }
      else if (e.key === 'Enter') { e.preventDefault();
        if (sugActive >= 0) pick(sugMatches[sugActive]);
        else if (search.value.trim()) pick(search.value.trim()); }
      else if (e.key === 'Escape') { suggest.style.display = 'none'; }
    });
    document.addEventListener('click', (e) => {
      if (!e.target.closest('#suggest') && e.target !== search) suggest.style.display = 'none';
    });
  }
  wireSearch();

  // Highlight only the FOCUS node's directional call flow, restricted to the
  // paths that pass THROUGH the hovered node. Hovering a callee shows the chain
  // from the focus down to it and its own downstream — but NOT that callee's
  // other callers that don't come from the focus (the off-focus "caller→callee"
  // edge stays dim). Hovering a caller mirrors this toward the focus. Hovering
  // the focus itself shows its whole flow (callers up + callees down).
  // Back-edges and same-level sibling edges are always excluded (they're not a
  // strict up/down step in the focus's hierarchy).
  function highlightConnected(name) {
    // Adjacency from the edges that are actually DRAWN (edgeEls), not from
    // current.edges — same-layer edges are filtered out of the rendered graph,
    // so a node reachable only through such a hidden edge must NOT light up.
    const fwd = new Map(), rev = new Map();
    for (const ee of edgeEls) {
      if (!fwd.has(ee.from)) fwd.set(ee.from, []);
      fwd.get(ee.from).push(ee.to);
      if (!rev.has(ee.to)) rev.set(ee.to, []);
      rev.get(ee.to).push(ee.from);
    }
    const reach = (start, adj) => {
      const seen = new Set([start]); const stack = [start];
      while (stack.length) { const c = stack.pop();
        for (const n of (adj.get(c) || [])) if (!seen.has(n)) { seen.add(n); stack.push(n); } }
      return seen;
    };
    const bfsDist = (start, adj) => {
      const dist = new Map([[start, 0]]); const q = [start];
      while (q.length) { const c = q.shift();
        for (const n of (adj.get(c) || [])) if (!dist.has(n)) { dist.set(n, dist.get(c) + 1); q.push(n); } }
      return dist;
    };
    // Distances from the FOCUS (not the hovered node) define the hierarchy:
    // callee-side gets deeper downstream, caller-side gets deeper upstream.
    const focus = current.focus;
    const distDown = bfsDist(focus, fwd);   // focus → callees
    const distUp = bfsDist(focus, rev);     // callers → focus
    const downF = new Set(distDown.keys()); // reachable from focus (callee side)
    const upF = new Set(distUp.keys());     // reaches focus (caller side)

    // Build the set of nodes to keep bright = the focus's flow through "name".
    const keep = new Set([focus, name]);
    if (name === focus) {
      for (const n of downF) keep.add(n);
      for (const n of upF) keep.add(n);
    } else if (downF.has(name)) {
      // hovered node is a callee: focus→name corridor + name's own downstream.
      const ancName = reach(name, rev);
      for (const n of downF) if (ancName.has(n)) keep.add(n);
      for (const n of reach(name, fwd)) keep.add(n);
    } else if (upF.has(name)) {
      // hovered node is a caller: name→focus corridor + name's own upstream.
      const descName = reach(name, fwd);
      for (const n of upF) if (descName.has(n)) keep.add(n);
      for (const n of reach(name, rev)) keep.add(n);
    }

    for (const [nm, g] of nodeEls) {
      g.classList.toggle('dimmed', !keep.has(nm));
      g.classList.toggle('hl-node', nm === name);
    }
    // Light an edge only when both endpoints are in the kept corridor AND it is
    // a strict step in the focus's hierarchy (deeper downstream / shallower
    // upstream) — so back-edges and same-level siblings stay dim.
    for (const ee of edgeEls) {
      let active = false;
      if (keep.has(ee.from) && keep.has(ee.to)) {
        const downStep = downF.has(ee.from) && downF.has(ee.to) &&
                         distDown.get(ee.to) > distDown.get(ee.from);
        const upStep = upF.has(ee.from) && upF.has(ee.to) &&
                       distUp.get(ee.from) > distUp.get(ee.to);
        active = downStep || upStep;
      }
      ee.path.classList.toggle('edge-hl', active);
      ee.path.classList.toggle('edge-dim', !active);
      ee.arrow.classList.toggle('edge-hl', active);
      ee.arrow.classList.toggle('edge-dim', !active);
      if (ee.halo) ee.halo.classList.toggle('edge-dim', !active);
    }
  }

  function clearHighlight() {
    for (const [, g] of nodeEls) g.classList.remove('dimmed', 'hl-node');
    for (const ee of edgeEls) {
      ee.path.classList.remove('edge-hl', 'edge-dim');
      ee.arrow.classList.remove('edge-hl', 'edge-dim');
      if (ee.halo) ee.halo.classList.remove('edge-dim');
    }
  }

  // Flash the bottom hint ("drag to pan … right-click for actions") to nudge the
  // user toward the right-click actions when they left-click a node (which only
  // highlights paths). Re-trigger on rapid clicks via a reflow.
  const hintEl = document.getElementById('hint');
  if (hintEl) hintEl.addEventListener('animationend', () => hintEl.classList.remove('blink'));
  function blinkHint() {
    if (!hintEl) return;
    hintEl.classList.remove('blink');
    void hintEl.offsetWidth;   // force reflow so the animation restarts
    hintEl.classList.add('blink');
  }

  // ── Node context menu (right-click) ──────────────────────────────────
  const ctxmenu = document.getElementById('ctxmenu');
  function closeMenu() { ctxmenu.style.display = 'none'; ctxmenu.innerHTML = ''; }
  function openNodeMenu(clientX, clientY, node) {
    ctxmenu.innerHTML = '';
    // Header: function name.
    const head = document.createElement('div');
    head.className = 'ctx-head';
    head.textContent = node.name;
    ctxmenu.appendChild(head);

    // ── Info section (read-only) ── kept visually separate from actions, and
    // mirrors the side panel's wording (Frame / Peak). No actions live here.
    const mkInfo = (text) => {
      const d = document.createElement('div'); d.className = 'ctx-info'; d.textContent = text;
      ctxmenu.appendChild(d); return d;
    };
    mkInfo('Frame: ' + fmtBytes(node.stackBytes));
    mkInfo('Peak: ' + fmtBytes(node.peak) + (node.recursive ? ' · recursive ↻' : ''));
    if (node.file) mkInfo('File: ' + node.file.split(/[\/\\]/).pop());

    // ── Actions section ── separated by a rule; identical verbs/labels to the
    // side panel so both menus read the same way.
    const sep = document.createElement('div'); sep.className = 'ctx-sep'; ctxmenu.appendChild(sep);

    const addItem = (label, key, handler, disabled) => {
      const it = document.createElement('div');
      it.className = 'ctx-item' + (disabled ? ' disabled' : '');
      const lab = document.createElement('span'); lab.textContent = label;
      it.appendChild(lab);
      if (key) { const k = document.createElement('span'); k.className = 'ctx-key'; k.textContent = key; it.appendChild(k); }
      if (!disabled) it.addEventListener('click', () => { closeMenu(); handler(); });
      ctxmenu.appendChild(it);
      return it;
    };

    // Shared action vocabulary (same as the side panel):
    //   Open source · Show details in side panel · Focus in call graph
    addItem('Open source', '', () => vscode.postMessage({ type: 'open', name: node.name }));
    addItem('Show details in side panel', '', () => vscode.postMessage({ type: 'stack', name: node.name }));
    // We're already in the graph, so "Focus in call graph" means refocus here.
    addItem(node.isFocus ? 'Focus in call graph (current)' : 'Focus in call graph', '',
      () => vscode.postMessage({ type: 'refocus', name: node.name }), node.isFocus);

    // Position, clamping to viewport.
    ctxmenu.style.display = 'block';
    const mw = ctxmenu.offsetWidth, mh = ctxmenu.offsetHeight;
    let x = clientX, y = clientY;
    if (x + mw > window.innerWidth) x = window.innerWidth - mw - 6;
    if (y + mh > window.innerHeight) y = window.innerHeight - mh - 6;
    ctxmenu.style.left = x + 'px';
    ctxmenu.style.top = y + 'px';
  }
  // Dismiss the menu on any outside click, scroll, or Escape.
  document.addEventListener('mousedown', (e) => {
    if (!e.target.closest('#ctxmenu')) closeMenu();
  });
  window.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeMenu(); });
  svg.addEventListener('wheel', () => closeMenu(), { passive: true });

  vscode.postMessage({ type: 'ready' });

  window.addEventListener('message', (ev) => {
    const m = ev.data;
    if (m.type === 'names') {
      if (Array.isArray(m.names)) {
        names = m.names;
        // If the search box is focused, refresh the open suggestion list now
        // that names are available.
        if (document.activeElement === search) runSearch();
      }
      return;
    }
    if (m.type === 'graph') {
      if (m.thresholds) thresholds = m.thresholds;
      if (Array.isArray(m.names)) names = m.names;
      if (typeof m.upHops === 'number') document.getElementById('up-val').textContent = m.upHops;
      if (typeof m.downHops === 'number') document.getElementById('down-val').textContent = m.downHops;
      current = m.data || { focus: '', nodes: [], edges: [] };
      const bnote = document.getElementById('budget-note');
      if (current.truncatedByBudget) {
        bnote.textContent = '⚠ Large neighborhood — showing the first ' +
          (current.nodes ? current.nodes.length : 0) +
          ' nodes. Increase focus depth selectively or refocus to see more.';
        bnote.style.display = '';
      } else {
        bnote.style.display = 'none';
      }
      if (m.focus) search.value = m.focus;
      layoutAndRender();
      // If opened via a per-root shortcut, briefly emphasize the target node so
      // the user sees where the root→fn path ends.
      if (m.highlight && nodeEls.has(m.highlight)) {
        highlightConnected(m.highlight);
        const g = nodeEls.get(m.highlight);
        if (g) {
          g.classList.add('pulse-target');
          setTimeout(() => { try { g.classList.remove('pulse-target'); } catch (_) {} }, 2400);
        }
      }
    }
  });

  function sevColor(node) {
    if (node.peak === undefined || node.peak === null) return '#888';
    if (node.peak <= thresholds.warn) return '#4caf50';
    if (node.peak <= thresholds.critical) return '#ffa726';
    return '#ef5350';
  }
  // File grouping: when enabled, nodes from the same source file are wrapped
  // in a labeled frame. Node fill/stroke is ALWAYS by severity (stack); the
  // file palette is used only for the frames. Stable per-file color.
  let groupFiles = false;
  const FILE_PALETTE = [
    '#4aa3ff', '#ff8a65', '#9ccc65', '#ba68c8', '#ffd54f', '#4db6ac',
    '#f06292', '#7986cb', '#a1887f', '#90a4ae', '#dce775', '#4fc3f7',
    '#e57373', '#81c784', '#fff176', '#ce93d8'
  ];
  const fileColorCache = new Map();
  function fileColor(file) {
    if (!file) return '#888';
    if (fileColorCache.has(file)) return fileColorCache.get(file);
    let h = 0;
    for (let i = 0; i < file.length; i++) h = (h * 31 + file.charCodeAt(i)) | 0;
    const c = FILE_PALETTE[Math.abs(h) % FILE_PALETTE.length];
    fileColorCache.set(file, c);
    return c;
  }
  function fmtBytes(n) {
    if (n === undefined || n === null) return '?';
    if (n < 1024) return n + 'B';
    if (n < 1024*1024) return (n/1024).toFixed(1) + 'KB';
    return (n/(1024*1024)).toFixed(1) + 'MB';
  }

  // Layered layout: x by layer (caller layers negative → left, callee
  // positive → right), y stacked within each layer.
  const NODE_W = 200, NODE_H = 38, X_GAP = 90, Y_GAP = 16;
  function layoutAndRender() {
    viewport.innerHTML = '';
    if (!current.nodes || current.nodes.length === 0) {
      showEmpty();
      return;
    }
    hideEmpty();
    const renderNodes = current.nodes;
    const renderEdges = current.edges;
    // Extra spacing when file frames are on, so labels/borders don't collide.
    const yGap = groupFiles ? 34 : Y_GAP;
    const xGap = groupFiles ? 130 : X_GAP;

    // Group nodes by layer.
    const byLayer = new Map();
    for (const n of renderNodes) {
      if (!byLayer.has(n.layer)) byLayer.set(n.layer, []);
      byLayer.get(n.layer).push(n);
    }
    const layers = [...byLayer.keys()].sort((a,b)=>a-b);
    const pos = new Map();
    const colW = NODE_W + xGap;
    const rowH = NODE_H + yGap;
    // Vertical centering per layer.
    let maxCol = 0;
    for (const l of layers) maxCol = Math.max(maxCol, byLayer.get(l).length);
    // When grouping, leave room for inter-group gaps in the tallest column.
    const groupSlack = groupFiles ? rowH : 0;
    const totalH = maxCol * rowH + groupSlack * 3;

    for (const l of layers) {
      const arr = byLayer.get(l);
      if (groupFiles) {
        // Keep same-file nodes adjacent so their frame is a tidy box; order
        // files by their heaviest node, and within a file by peak desc.
        const fileMax = new Map();
        for (const n of arr) {
          const f = n.file || '?';
          fileMax.set(f, Math.max(fileMax.get(f) || 0, n.peak || 0));
        }
        arr.sort((a, b) => {
          const fa = a.file || '?', fb = b.file || '?';
          if (fa !== fb) {
            const d = (fileMax.get(fb) || 0) - (fileMax.get(fa) || 0);
            if (d !== 0) return d;
            return fa.localeCompare(fb);
          }
          return (b.peak || 0) - (a.peak || 0);
        });
        // Lay out with an extra gap whenever the file changes (separates the
        // frames vertically).
        const FRAME_GAP = 22;
        let totalGaps = 0;
        for (let i = 1; i < arr.length; i++)
          if ((arr[i].file || '?') !== (arr[i-1].file || '?')) totalGaps += FRAME_GAP;
        const colH = arr.length * rowH + totalGaps;
        let yc = (totalH - colH) / 2;
        for (let i = 0; i < arr.length; i++) {
          if (i > 0 && (arr[i].file || '?') !== (arr[i-1].file || '?')) yc += FRAME_GAP;
          pos.set(arr[i].name, { x: l * colW, y: yc });
          yc += rowH;
        }
      } else {
        // Sort within layer by peak desc so heavy nodes cluster at top.
        arr.sort((a,b)=>(b.peak||0)-(a.peak||0));
        const colH = arr.length * rowH;
        const yStart = (totalH - colH) / 2;
        arr.forEach((n, i) => {
          pos.set(n.name, { x: l * colW, y: yStart + i * rowH });
        });
      }
    }

    // File-group frames (drawn first, behind everything). When enabled, each
    // source file gets a labeled rounded rectangle enclosing all its nodes.
    if (groupFiles) {
      // Frame nodes by (file, layer): one tidy box per file per column. A
      // file spanning multiple layers gets one box in each, which keeps the
      // boxes compact instead of one huge rectangle spanning the whole graph.
      const boxes = new Map(); // "file\u0000layer" -> {file,minX,minY,maxX,maxY}
      for (const n of renderNodes) {
        const p = pos.get(n.name);
        if (!p) continue;
        const f = n.file || '?';
        const key = f + '\u0000' + n.layer;
        let b = boxes.get(key);
        if (!b) { b = { file: f, minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity, count: 0 }; boxes.set(key, b); }
        b.minX = Math.min(b.minX, p.x);
        b.minY = Math.min(b.minY, p.y);
        b.maxX = Math.max(b.maxX, p.x + NODE_W);
        b.maxY = Math.max(b.maxY, p.y + NODE_H);
        b.count++;
      }
      const PAD = 12, LABEL_H = 15;
      for (const b of boxes.values()) {
        const col = fileColor(b.file);
        const x = b.minX - PAD, y = b.minY - PAD - LABEL_H;
        const w = (b.maxX - b.minX) + PAD * 2;
        const h = (b.maxY - b.minY) + PAD * 2 + LABEL_H;
        const frame = document.createElementNS(SVGNS, 'rect');
        frame.setAttribute('x', x); frame.setAttribute('y', y);
        frame.setAttribute('width', w); frame.setAttribute('height', h);
        frame.setAttribute('rx', '10');
        frame.setAttribute('class', 'file-frame');
        frame.setAttribute('stroke', col);
        frame.setAttribute('fill', col);
        viewport.appendChild(frame);
        const tail = b.file.split(/[\\/]/).slice(-1)[0];
        const label = document.createElementNS(SVGNS, 'text');
        label.setAttribute('x', x + 10); label.setAttribute('y', y + 12);
        label.setAttribute('class', 'file-frame-label');
        label.setAttribute('fill', col);
        label.textContent = tail;
        viewport.appendChild(label);
      }
    }

    // Draw edges first (under nodes). Keep references for hover highlighting.
    // Each edge gets a wide, background-colored "halo" underlay drawn first so
    // the visible stroke stays readable where it crosses over a node box.
    //
    // Detect bidirectional pairs (A→B AND B→A): drawing both on the same center
    // line would overlap and pass straight through the node boxes (e.g. mutual
    // recursion rec_ping↔rec_pong). For those — and for any backward or
    // same-column edge — we route the curve OUT of the node top/bottom and bow
    // it away from the straight line so both directions are visible.
    // Node → layer map, so we can drop edges between two nodes that sit in the
    // SAME layer (same column / same hierarchy level). Those aren't part of the
    // up/down call hierarchy the layered view conveys — they'd render as
    // sideways/curved connectors that clutter the picture — so we don't draw
    // them. Self-calls (from === to) are kept (drawn as a self-loop arc).
    const layerOf = new Map();
    for (const n of renderNodes) layerOf.set(n.name, n.layer);
    const drawEdges = renderEdges.filter(e =>
      e.from === e.to || layerOf.get(e.from) !== layerOf.get(e.to));
    const edgeKey = new Set();
    for (const e of drawEdges) edgeKey.add(e.from + '\u0000' + e.to);
    const hasReverse = (e) => edgeKey.has(e.to + '\u0000' + e.from);
    edgeEls = [];
    // Arrow heads go in their own group appended AFTER the nodes, so a head
    // sitting on a node's border (where an edge meets the box) is drawn on top
    // of the node instead of being hidden behind it.
    const arrowLayer = document.createElementNS(SVGNS, 'g');
    arrowLayer.setAttribute('class', 'arrow-layer');
    // A filled arrow head at (tx,ty) pointing along unit-ish direction (dx,dy).
    // Sized large enough that the call direction reads unambiguously, and
    // rotated to match the curve's incoming tangent (not a fixed angle).
    const AR_LEN = 11, AR_W = 6;   // length back from tip, half-width
    function arrowPath(tx, ty, dx, dy) {
      const m = Math.hypot(dx, dy) || 1;
      const ux = dx / m, uy = dy / m;        // unit direction (into the tip)
      const px = -uy, py = ux;               // perpendicular
      const bx = tx - ux * AR_LEN, by = ty - uy * AR_LEN;  // base center
      const x1 = bx + px * AR_W, y1 = by + py * AR_W;
      const x2 = bx - px * AR_W, y2 = by - py * AR_W;
      return 'M' + tx.toFixed(1) + ',' + ty.toFixed(1) +
             ' L' + x1.toFixed(1) + ',' + y1.toFixed(1) +
             ' L' + x2.toFixed(1) + ',' + y2.toFixed(1) + ' Z';
    }
    // Cubic Bézier tangent direction at t=1 is (P3 - P2); pull the visible
    // stroke back a few px from the tip so the line doesn't poke through the
    // arrow head.
    function cubicEndDir(c2x, c2y, p3x, p3y) {
      return [p3x - c2x, p3y - c2y];
    }
    for (const e of drawEdges) {
      const a = pos.get(e.from), b = pos.get(e.to);
      if (!a || !b) continue;
      const cls = 'edge' + (e.indirect ? ' indirect' : '') + (e.fpVerified ? ' fp-verified' : '') + (e.offFocus ? ' cross' : '');
      let d, arrowD;
      if (e.from === e.to) {
        // Self-loop: a small rounded arc on top of the node so it's clearly
        // visible as a self-call instead of a hidden line through the box.
        const cx = a.x + NODE_W / 2, top = a.y;
        const lx = cx - 16, rx = cx + 16, ly = top, peak = top - 30;
        d = 'M' + lx + ',' + ly + ' C' + (lx - 12) + ',' + peak + ' ' + (rx + 12) + ',' + peak + ' ' + rx + ',' + ly;
        // Tip comes down into the node top at the right foot; tangent ≈ downward.
        arrowD = arrowPath(rx, ly, rx - (rx + 12), ly - peak);
      } else {
        const acx = a.x + NODE_W / 2, bcx = b.x + NODE_W / 2;
        const backward = bcx < acx - 1;            // target is to the LEFT
        const sameCol = Math.abs(bcx - acx) <= 1;  // stacked vertically
        const bidir = hasReverse(e);
        if (backward || sameCol || bidir) {
          // Route from the node's top/bottom edge, bowing away from the straight
          // line so the curve clears both boxes. Bidirectional pairs bow to
          // opposite sides (backward up, its forward partner down) so the two
          // directions — and their arrow heads — never coincide.
          const bowUp = bidir ? backward : (backward || sameCol);
          const ay = bowUp ? a.y : a.y + NODE_H;       // leave top or bottom
          const by = bowUp ? b.y : b.y + NODE_H;       // enter top or bottom
          const dir = bowUp ? -1 : 1;
          const span = Math.abs(bcx - acx);
          const lift = dir * (40 + Math.min(span, 240) * 0.25);
          const c1x = acx, c1y = ay + lift;
          const c2x = bcx, c2y = by + lift;
          d = 'M' + acx + ',' + ay + ' C' + c1x + ',' + c1y + ' ' + c2x + ',' + c2y + ' ' + bcx + ',' + by;
          const [dx, dy] = cubicEndDir(c2x, c2y, bcx, by);
          arrowD = arrowPath(bcx, by, dx, dy);
        } else {
          // Forward edge. If another node sits between source and target on the
          // straight center line (a skip-layer edge, e.g. A→C with B between),
          // the line would cut through that node — so bow it above the boxes.
          const x1 = a.x + NODE_W, y1 = a.y + NODE_H / 2;
          const x2 = b.x, y2 = b.y + NODE_H / 2;
          const yMid = (y1 + y2) / 2;
          let blocked = false;
          for (const [nm, q] of pos) {
            if (nm === e.from || nm === e.to) continue;
            const qcx = q.x + NODE_W / 2;
            // between horizontally, and vertically overlapping the line band
            if (qcx > a.x + NODE_W && qcx < b.x &&
                q.y < yMid + NODE_H / 2 && q.y + NODE_H > yMid - NODE_H / 2) {
              blocked = true; break;
            }
          }
          if (blocked) {
            const acx2 = a.x + NODE_W / 2, bcx2 = b.x + NODE_W / 2;
            const ay = a.y, by = b.y;                // leave/enter node tops
            const span = Math.abs(bcx2 - acx2);
            const lift = -(46 + Math.min(span, 300) * 0.22);
            const c2x = bcx2, c2y = by + lift;
            d = 'M' + acx2 + ',' + ay + ' C' + acx2 + ',' + (ay + lift) + ' ' +
                c2x + ',' + c2y + ' ' + bcx2 + ',' + by;
            const [dx, dy] = cubicEndDir(c2x, c2y, bcx2, by);
            arrowD = arrowPath(bcx2, by, dx, dy);
          } else {
            const mx = (x1 + x2) / 2;
            d = 'M' + x1 + ',' + y1 + ' C' + mx + ',' + y1 + ' ' + mx + ',' + y2 + ' ' + x2 + ',' + y2;
            const [dx, dy] = cubicEndDir(mx, y2, x2, y2);
            arrowD = arrowPath(x2, y2, dx, dy);
          }
        }
      }
      // Halo underlay (same path, thicker, editor-background colored) → the edge
      // reads clearly even when it passes over a node or another edge.
      const halo = document.createElementNS(SVGNS, 'path');
      halo.setAttribute('d', d);
      halo.setAttribute('class', 'edge-halo' + (e.offFocus ? ' cross' : ''));
      viewport.appendChild(halo);
      const path = document.createElementNS(SVGNS, 'path');
      path.setAttribute('d', d);
      path.setAttribute('class', cls);
      viewport.appendChild(path);
      const arr = document.createElementNS(SVGNS, 'path');
      arr.setAttribute('d', arrowD);
      arr.setAttribute('class', 'edge-arrow' + (e.offFocus ? ' cross' : ''));
      arrowLayer.appendChild(arr);
      edgeEls.push({ from: e.from, to: e.to, path, arrow: arr, halo });
    }

    // Draw nodes.
    nodeEls = new Map();
    for (const n of renderNodes) {
      const p = pos.get(n.name);
      if (!p) continue;
      const g = document.createElementNS(SVGNS, 'g');
      g.setAttribute('transform', 'translate(' + p.x + ',' + p.y + ')');

      const rect = document.createElementNS(SVGNS, 'rect');
      rect.setAttribute('width', NODE_W);
      rect.setAttribute('height', NODE_H);
      rect.setAttribute('rx', '6');
      rect.setAttribute('class', 'node-rect');
      rect.setAttribute('fill', 'var(--vscode-editorWidget-background, var(--vscode-editor-background))');
      rect.setAttribute('stroke', n.isFocus ? 'var(--vscode-focusBorder)' : sevColor(n));
      rect.setAttribute('stroke-width', n.isFocus ? '2.5' : '1.5');
      // Roots get a dashed border so entry points stand out from interior
      // nodes (which helps read "where does a chain start").
      if (n.isRoot && !n.isFocus) rect.setAttribute('stroke-dasharray', '5 3');
      g.appendChild(rect);

      // Severity bar on the left edge.
      const bar = document.createElementNS(SVGNS, 'rect');
      bar.setAttribute('width', '4'); bar.setAttribute('height', NODE_H);
      bar.setAttribute('rx', '2'); bar.setAttribute('fill', sevColor(n));
      g.appendChild(bar);

      // Name. Reserve room for any prefix glyphs, then truncate to what fits
      // the (wider) node. ~7px per char at 11px monospace, minus padding.
      const label = document.createElementNS(SVGNS, 'text');
      label.setAttribute('x', '10'); label.setAttribute('y', '16');
      label.setAttribute('class', 'node-label');
      label.setAttribute('fill', 'var(--vscode-foreground)');
      let prefix = '';
      if (n.isRoot) prefix += (n.rootKind === 'pinned' ? '📌 ' : '⚓ ');
      if (n.recursive) prefix += '↻ ';
      if (n.fpVerified) prefix += '✓ ';
      if (n.truncatedCallers) prefix = '… ' + prefix;
      const maxChars = Math.max(6, Math.floor((NODE_W - 18) / 6.6) - prefix.length);
      let disp = n.name;
      if (disp.length > maxChars) disp = disp.slice(0, maxChars - 1) + '…';
      label.textContent = prefix + disp;
      g.appendChild(label);
      // Hover tooltip (SVG <title>): name plus a short info summary, mirroring
      // the side panel's wording (Frame / Peak / root / recursion / fp).
      const gt = document.createElementNS(SVGNS, 'title');
      const tparts = [n.name];
      tparts.push('Frame: ' + fmtBytes(n.stackBytes));
      tparts.push('Peak: ' + fmtBytes(n.peak));
      if (n.file) tparts.push('File: ' + n.file.split(/[\/\\]/).pop());
      const roleBits = [];
      if (n.isRoot && n.rootKind === 'pinned') roleBits.push('📌 pinned root');
      else if (n.isRoot && n.rootKind === 'auto') roleBits.push('⚓ auto root');
      if (n.recursive) roleBits.push('recursive ↻');
      if (n.fpVerified) roleBits.push('fp bound ✓');
      else if (n.hasUnboundFp) roleBits.push('fp estimated (not bound) ⚠');
      if (roleBits.length) tparts.push(roleBits.join(' · '));
      gt.textContent = tparts.join('\n');
      g.appendChild(gt);

      // Sub-line: depth/frame/peak summary.
      const sub = document.createElementNS(SVGNS, 'text');
      sub.setAttribute('x', '10'); sub.setAttribute('y', '29');
      sub.setAttribute('class', 'node-sub');
      sub.setAttribute('fill', 'var(--vscode-descriptionForeground)');
      sub.textContent = 'f:' + fmtBytes(n.stackBytes) + '  peak:' + fmtBytes(n.peak)
        + (n.truncatedCallees ? '  →…' : '');
      g.appendChild(sub);

      // Interactions: right-click opens a context menu (open source, make
      // root, show stack). Left-click just highlights paths (via hover) and
      // flashes the bottom hint toward "right-click for actions"; it does not
      // refocus, to avoid accidental navigation.
      rect.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        e.stopPropagation();
        openNodeMenu(e.clientX, e.clientY, n);
      });
      rect.addEventListener('click', () => blinkHint());
      // Hover: highlight the focus's call flow that passes through this node
      // (the focus↔node corridor + the node's own continuation), dim the rest.
      g.addEventListener('mouseenter', () => highlightConnected(n.name));
      g.addEventListener('mouseleave', () => clearHighlight());
      const title = document.createElementNS(SVGNS, 'title');
      title.textContent = n.name + '\n' +
        'frame: ' + fmtBytes(n.stackBytes) + ' · peak: ' + fmtBytes(n.peak) +
        (n.recursive ? ' · recursive' : '') + '\n(right-click for actions)';
      g.appendChild(title);

      nodeEls.set(n.name, g);
      viewport.appendChild(g);
    }
    // Arrow heads on top of everything, so they're never hidden behind a node.
    viewport.appendChild(arrowLayer);

    // Auto-fit on first render after a refocus. Defer to the next frame so
    // the browser has laid out the freshly-inserted SVG and getBBox/clientW
    // return real numbers (they're 0 if measured synchronously on first open).
    requestAnimationFrame(() => requestAnimationFrame(fitToView));
  }

  function fitToView() {
    // Measure in untransformed space: temporarily clear the transform so the
    // bbox reflects raw layout coordinates, not the current pan/zoom.
    viewport.removeAttribute('transform');
    const bbox = viewport.getBBox();
    // Prefer the SVG's rendered size; fall back to the window if it hasn't
    // been laid out yet (can happen on the very first paint).
    let W = svg.clientWidth, H = svg.clientHeight;
    if (!W || !H) {
      const r = svg.getBoundingClientRect();
      W = r.width || window.innerWidth;
      H = (r.height || window.innerHeight - 40);
    }
    if (bbox.width === 0 || bbox.height === 0 || !W || !H) { applyView(); return; }
    const pad = 48;
    // Allow zooming IN for small graphs (up to 2x) so they fill the screen,
    // and of course zooming out for large ones.
    const k = Math.min((W - pad * 2) / bbox.width, (H - pad * 2) / bbox.height, 2);
    view.k = k > 0 ? k : 1;
    view.x = (W - bbox.width * view.k) / 2 - bbox.x * view.k;
    view.y = (H - bbox.height * view.k) / 2 - bbox.y * view.k;
    applyView();
  }
  function applyView() {
    viewport.setAttribute('transform',
      'translate(' + view.x + ',' + view.y + ') scale(' + view.k + ')');
  }

  // Pan & zoom.
  let panning = false, panStart = null;
  svg.addEventListener('mousedown', (e) => {
    if (e.button !== 0) return;           // only left-drag pans
    if (e.target.closest('.node-rect')) return;
    closeMenu();
    panning = true; panStart = { x: e.clientX - view.x, y: e.clientY - view.y };
    svg.classList.add('grabbing');
  });
  // Suppress the browser context menu on empty canvas (node menus handle
  // their own right-click and stopPropagation).
  svg.addEventListener('contextmenu', (e) => { e.preventDefault(); });
  window.addEventListener('mousemove', (e) => {
    if (!panning) return;
    view.x = e.clientX - panStart.x; view.y = e.clientY - panStart.y; applyView();
  });
  window.addEventListener('mouseup', () => { panning = false; svg.classList.remove('grabbing'); });
  svg.addEventListener('wheel', (e) => {
    e.preventDefault();
    const factor = e.deltaY < 0 ? 1.1 : 0.9;
    const mx = e.clientX, my = e.clientY;
    const nk = Math.max(0.2, Math.min(3, view.k * factor));
    // Zoom toward cursor.
    view.x = mx - (mx - view.x) * (nk / view.k);
    view.y = my - (my - view.y) * (nk / view.k);
    view.k = nk; applyView();
  }, { passive: false });

  // Hop controls.
  for (const btn of document.querySelectorAll('[data-up]')) {
    btn.addEventListener('click', () => {
      const cur = parseInt(document.getElementById('up-val').textContent, 10);
      vscode.postMessage({ type: 'setHops', up: cur + parseInt(btn.getAttribute('data-up'),10),
        down: parseInt(document.getElementById('down-val').textContent,10) });
    });
  }
  for (const btn of document.querySelectorAll('[data-down]')) {
    btn.addEventListener('click', () => {
      const cur = parseInt(document.getElementById('down-val').textContent, 10);
      vscode.postMessage({ type: 'setHops', down: cur + parseInt(btn.getAttribute('data-down'),10),
        up: parseInt(document.getElementById('up-val').textContent,10) });
    });
  }

  // File-grouping toggle: wraps same-file nodes in labeled frames. Node
  // colors stay severity-based regardless.
  const groupChk = document.getElementById('group-files');
  groupChk.addEventListener('change', () => {
    groupFiles = groupChk.checked;
    layoutAndRender();
  });

  // Search box with suggestions — mirrors the side-panel "function lookup":
  // exact match first, then prefix matches, then substring matches, with the
  // matched span highlighted in each row.
  function highlight(name, q) {
    const lower = name.toLowerCase();
    const idx = lower.indexOf(q);
    if (idx < 0 || !q) return escapeHtml(name);
    return escapeHtml(name.slice(0, idx)) +
      '<span class="sug-hit">' + escapeHtml(name.slice(idx, idx + q.length)) + '</span>' +
      escapeHtml(name.slice(idx + q.length));
  }
  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, c =>
      ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' })[c]);
  }
  function renderSug() {
    if (sugMatches.length === 0) { suggest.style.display = 'none'; return; }
    suggest.innerHTML = '';
    sugMatches.forEach((n, i) => {
      const d = document.createElement('div');
      d.className = 'sug-item' + (i === sugActive ? ' active' : '');
      d.innerHTML = highlight(n, lastQuery);
      // mousedown (not click) + preventDefault keeps focus on the input so the
      // blur/outside-click handler doesn't close the list before we pick.
      d.addEventListener('mousedown', (e) => { e.preventDefault(); pick(n); });
      d.addEventListener('mouseenter', () => { sugActive = i; refreshActive(); });
      suggest.appendChild(d);
    });
    // Position the dropdown in viewport coordinates, anchored to the input, so
    // no ancestor (toolbar/search-wrap) can clip it and it always sits on top.
    // Use an explicit 'block' (not empty string), otherwise clearing the inline
    // style falls back to the stylesheet rule (#suggest display:none) and the
    // list stays hidden even though it has items.
    suggest.style.display = 'block';
    positionSuggest();
  }
  function positionSuggest() {
    if (!search) return;
    const r = search.getBoundingClientRect();
    suggest.style.position = 'fixed';
    suggest.style.top = (r.bottom + 2) + 'px';
    suggest.style.left = r.left + 'px';
    suggest.style.width = Math.max(r.width, 220) + 'px';
    suggest.style.zIndex = '9999';
  }
  function refreshActive() {
    const items = suggest.querySelectorAll('.sug-item');
    items.forEach((el, i) => {
      el.classList.toggle('active', i === sugActive);
      if (i === sugActive) el.scrollIntoView({ block: 'nearest' });
    });
  }
  function pick(name) {
    search.value = name; suggest.style.display = 'none'; sugMatches = []; sugActive = -1;
    vscode.postMessage({ type: 'refocus', name });
  }
  function computeMatches(v) {
    // Mirrors the side-panel "function lookup": exact first, then prefix,
    // then substring. The names list is already alphabetical, so each bucket
    // stays sorted. With no query, list everything so focusing the box shows
    // the full function list, like browsing.
    if (!v) return names.slice();
    const exact = [], starts = [], has = [];
    for (const n of names) {
      const nl = n.toLowerCase();
      if (nl === v) exact.push(n);
      else if (nl.startsWith(v)) starts.push(n);
      else if (nl.includes(v)) has.push(n);
    }
    return exact.concat(starts, has);
  }
  function runSearch() {
    // If the symbol list hasn't arrived yet, ask the extension for it so the
    // first interaction still populates suggestions (don't depend solely on the
    // graph push having included names).
    if (!names || names.length === 0) {
      vscode.postMessage({ type: 'requestNames' });
    }
    const v = search.value.trim().toLowerCase();
    lastQuery = v;
    sugMatches = computeMatches(v).slice(0, 200);
    sugActive = sugMatches.length ? 0 : -1;
    renderSug();
  }

  function showEmpty(msg) {
    hideEmpty();
    const d = document.createElement('div');
    d.className = 'empty-msg'; d.id = 'empty-msg';
    d.textContent = msg || 'No analysis yet, or focus function not found. Run an analysis and search for a function.';
    document.body.appendChild(d);
  }
  function hideEmpty() {
    const e = document.getElementById('empty-msg');
    if (e) e.remove();
  }
  window.addEventListener('resize', () => fitToView());
  }  // end boot()

  // Start once the DOM is ready (handles the case where this script runs before
  // <body> has been parsed in the webview).
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
</script>
</body>
</html>`;
