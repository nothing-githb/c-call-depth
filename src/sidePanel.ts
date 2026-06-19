// src/sidePanel.ts
// WebView shown in the activity bar. Lets the user search any function and
// see its depth/frame/peak, its callers, callees, and chain origins.
//
// Architecture:
//   extension -> webview:
//     { type: "state",   summary: { total, withStack } }
//     { type: "names",   names: string[] }                  (autocomplete)
//     { type: "top",     entries: TopEntry[] }              (top-by-peak list)
//     { type: "topDepth"/"topFrame"/"recursion"/"unboundFp", entries: [...] } (overview lists)
//     { type: "result",  payload: SidePanelResult | null }  (search result)
//   webview -> extension:
//     { type: "ready" }
//     { type: "query", name: string }
//     { type: "open",  file: string, line: number, col: number }

import * as vscode from "vscode";
import { FunctionRecord, DepthInfo, pathsFrom, pathsTo, longestPathFrom, CallPath } from "./callGraph";

export interface SidePanelState {
  byName: Map<string, FunctionRecord>;
  depth: Map<string, DepthInfo>;
  pathsLimit: number;
  pathsMaxDepth: number;
  pinnedRoots?: ReadonlySet<string>;
  /** thresholds for severity coloring */
  thresholdWarn: number;
  thresholdCritical: number;
}

export interface SidePanelDeps {
  getState(): SidePanelState;
}

interface PathDto {
  nodes: string[];
  rootIsPinned: boolean;
  totalStack: number;
  truncatedByCycle: boolean;
  truncatedByDepth?: boolean;
}

interface PerRootDto {
  rootName: string;
  rootIsPinned: boolean;
  isAuto?: boolean;
  depth: number;
  cumulativeStack?: number;
  cumulativeBounded?: boolean;
}

interface SidePanelResult {
  name: string;
  file: string;
  nameLine: number;
  nameCol: number;
  depth: number;
  recursive: boolean;
  recursiveViaFp: boolean;
  fpVerified: boolean;
  fpSites?: { line: number; via?: string; candidates: string[]; overridden: boolean }[];
  pinnedRoot: boolean;
  autoRoot: boolean;
  stackBytes?: number;
  stackQualifier?: string;
  cumulativeStack?: number;
  cumulativeBounded?: boolean;
  perRoot: PerRootDto[];
  outgoing: PathDto[];
  incoming: PathDto[];
  cycles: PathDto[];
  cyclesTruncated?: boolean;
  outgoingTotal: number;
  incomingTotal: number;
  pathCap: number;
  thresholdWarn: number;
  thresholdCritical: number;
}

interface TopEntry {
  name: string;
  peak: number;
  bounded: boolean;
  recursive: boolean;
  recursiveViaFp: boolean;
  pinnedRoot: boolean;
  autoRoot: boolean;
}

interface RecEntry {
  name: string;
  viaFp: boolean;
  peak: number;
  file: string;
}
const TOP_LIMIT = 10;
export class SidePanelProvider implements vscode.WebviewViewProvider {
    static viewType = "cCallDepth.sidePanel";
    private deps: SidePanelDeps;
    private view?: vscode.WebviewView;
    private pendingLookup?: string;
    constructor(deps: SidePanelDeps) {
        this.deps = deps;
    }
    resolveWebviewView(view) {
        this.view = view;
        // retainContextWhenHidden keeps the webview's DOM (and the currently open
        // function, scroll position, filter text, collapse state) alive when the
        // user switches to another view in the sidebar and comes back — otherwise
        // the panel is torn down and reloads empty.
        view.webview.options = { enableScripts: true, retainContextWhenHidden: true };
        view.webview.html = this.getHtml(view.webview);
        view.webview.onDidReceiveMessage(msg => this.onMessage(msg));
        // If a lookup was requested before the view existed, satisfy it now.
        if (this.pendingLookup) {
            const name = this.pendingLookup;
            this.pendingLookup = undefined;
            // Defer until the webview script has signalled ready; onMessage("ready")
            // triggers notifyAnalysisUpdated, after which a query is safe.
            setTimeout(() => this.sendQuery(name), 200);
        }
    }
    /** Open/focus the panel and show the given function. Used by the hover's
     *  "open in side panel" link so the user can expand paths there. */
    async lookupFunction(name) {
        // Make the view visible. focus() resolves the view if it was never
        // opened; if it's collapsed, this expands it.
        await vscode.commands.executeCommand("cCallDepth.sidePanel.focus");
        if (!this.view) {
            // View is being created; resolveWebviewView will pick this up.
            this.pendingLookup = name;
            return;
        }
        this.sendQuery(name);
    }
    sendQuery(name) {
        if (!this.view)
            return;
        this.view.webview.postMessage({ type: "externalQuery", name });
    }
    notifyAnalysisUpdated() {
        if (!this.view)
            return;
        const state = this.deps.getState();
        const names = [];
        let withStack = 0;
        for (const [name, rec] of state.byName) {
            if (rec.ghost)
                continue;
            names.push(name);
            if (rec.stackBytes !== undefined)
                withStack++;
        }
        names.sort();
        // Top-by-peak (excluding ghosts)
        const ranked = [];
        for (const [name, rec] of state.byName) {
            if (rec.ghost)
                continue;
            const info = state.depth.get(name);
            if (!info)
                continue;
            // Rank by each function's OWN downward peak (frame + heaviest callee
            // chain), so the list highlights the functions that consume the most
            // stack themselves — not those that merely sit under a heavy root. The
            // entry-inclusive per-root peaks live in the detail view's per-root table.
            const peak = info.cumulativeStack;
            const bounded = info.cumulativeBounded === true;
            if (peak === undefined)
                continue;
            ranked.push({
                name,
                file: state.byName.get(name)?.file ?? "",
                peak,
                bounded,
                recursive: info.recursive,
                recursiveViaFp: info.recursiveViaFp === true,
                pinnedRoot: info.isPinnedRoot === true,
                autoRoot: info.isAutoRoot === true
            });
        }
        ranked.sort((a, b) => b.peak - a.peak);
        // Send the full ranked list so the panel's path filter can search across all
        // functions; the panel shows only the top TOP_LIMIT when no filter is set.
        const top = ranked;
        // Top-by-depth: rank by each function's OWN downward depth (longest callee
        // chain beneath it) — the depth analogue of top-by-peak. Surfaces the
        // functions that head the deepest call structures (e.g. deep chains).
        const topDepth = [];
        for (const [name, rec] of state.byName) {
            if (rec.ghost)
                continue;
            const info = state.depth.get(name);
            if (!info)
                continue;
            const depth = info.downDepth;
            if (depth === undefined || depth === null)
                continue;
            topDepth.push({
                name,
                file: state.byName.get(name)?.file ?? "",
                depth,
                bounded: info.downDepthBounded === true,
                peak: info.cumulativeStack,
                recursive: info.recursive,
                recursiveViaFp: info.recursiveViaFp === true,
                pinnedRoot: info.isPinnedRoot === true,
                autoRoot: info.isAutoRoot === true
            });
        }
        topDepth.sort((a, b) => b.depth - a.depth);
        // Top-by-frame: rank by each function's OWN stack frame (the -fstack-usage
        // size), distinct from peak (the cumulative worst case below it). Surfaces
        // the single fattest frames. Functions without a known frame are omitted.
        const topFrame = [];
        for (const [name, rec] of state.byName) {
            if (rec.ghost)
                continue;
            const frame = rec.stackBytes;
            if (frame === undefined || frame === null)
                continue;
            const info = state.depth.get(name);
            topFrame.push({
                name,
                file: rec.file,
                frame,
                qualifier: rec.stackQualifier || "",
                peak: info?.cumulativeStack,
                recursive: info?.recursive === true,
                recursiveViaFp: info?.recursiveViaFp === true,
                pinnedRoot: info?.isPinnedRoot === true,
                autoRoot: info?.isAutoRoot === true
            });
        }
        topFrame.sort((a, b) => b.frame - a.frame);
        // Dedicated recursion list: every function in a cycle, certain (direct)
        // ones first, then possible (fp-only) ones, each sorted by peak desc.
        const recList = [];
        for (const [name, rec] of state.byName) {
            if (rec.ghost)
                continue;
            const info = state.depth.get(name);
            if (!info || !info.recursive)
                continue;
            const r2 = ranked.find(e => e.name === name);
            // Shortest cycle length through this function (self=1, mutual=2, …). For
            // fp-only over-approx with no concrete edge, shortestCycle returns null.
            const sc = this.shortestCycle(state.byName, name);
            const hops = sc ? Math.max(1, sc.nodes.length - 1) : 0;
            recList.push({
                name,
                viaFp: info.recursiveViaFp === true,
                peak: r2?.peak ?? (info.cumulativeStack ?? 0),
                file: rec.file,
                hops
            });
        }
        recList.sort((a, b) => (a.viaFp === b.viaFp) ? (b.peak - a.peak) : (a.viaFp ? 1 : -1));
        // Functions containing UNBOUND (still over-approximated) function-pointer
        // call sites — i.e. at least one fp site that no override covers. These are
        // the places where the stack analysis rests on inferred fp targets and may
        // be worth verifying manually (relevant for DO-178C evidence).
        const unboundFp = [];
        for (const [name, rec] of state.byName) {
            if (rec.ghost)
                continue;
            const info = state.depth.get(name);
            if (!info || !Array.isArray(info.fpSites))
                continue;
            const open = info.fpSites.filter(s => s.overridden !== true).length;
            if (open === 0)
                continue;
            unboundFp.push({
                name, file: rec.file, sites: open,
                peak: info.cumulativeStack ?? 0
            });
        }
        unboundFp.sort((a, b) => b.peak - a.peak);
        this.view.webview.postMessage({ type: "names", names });
        this.view.webview.postMessage({
            type: "state",
            summary: { total: names.length, withStack },
            thresholds: { warn: state.thresholdWarn, critical: state.thresholdCritical },
            pathsLimit: state.pathsLimit
        });
        this.view.webview.postMessage({ type: "top", entries: top });
        this.view.webview.postMessage({ type: "topDepth", entries: topDepth });
        this.view.webview.postMessage({ type: "topFrame", entries: topFrame });
        this.view.webview.postMessage({ type: "unboundFp", entries: unboundFp });
        this.view.webview.postMessage({ type: "recursion", entries: recList });
    }
    onMessage(msg) {
        if (!this.view)
            return;
        if (msg?.type === "ready") {
            this.notifyAnalysisUpdated();
            return;
        }
        if (msg?.type === "query" && typeof msg.name === "string") {
            const result = this.resolveQuery(msg.name);
            this.view.webview.postMessage({ type: "result", payload: result });
            return;
        }
        if (msg?.type === "open" && typeof msg.file === "string") {
            const uri = vscode.Uri.file(msg.file);
            const line = typeof msg.line === "number" ? msg.line : 0;
            const col = typeof msg.col === "number" ? msg.col : 0;
            vscode.window.showTextDocument(uri).then(editor => {
                const pos = new vscode.Position(line, col);
                editor.selection = new vscode.Selection(pos, pos);
                editor.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.InCenter);
            });
            return;
        }
        if (msg?.type === "goto" && typeof msg.name === "string") {
            vscode.commands.executeCommand("cCallDepth.gotoFunction", msg.name);
            return;
        }
        if (msg?.type === "graph" && typeof msg.name === "string") {
            vscode.commands.executeCommand("cCallDepth.openGraph", msg.name);
            return;
        }
        if (msg?.type === "openGraphFromRoot" && typeof msg.root === "string" && typeof msg.target === "string") {
            vscode.commands.executeCommand("cCallDepth.openGraphFromRoot", { root: msg.root, target: msg.target, depth: typeof msg.depth === "number" ? msg.depth : undefined });
            return;
        }
        if (msg?.type === "requestFnInfo" && typeof msg.name === "string") {
            // Provide Frame/Peak for the context menu's info section (read-only).
            const st = this.deps.getState();
            const rec = st.byName.get(msg.name);
            const info = st.depth.get(msg.name);
            this.view?.webview.postMessage({
                type: "fnInfo",
                name: msg.name,
                file: rec ? rec.file : undefined,
                frame: rec ? rec.stackBytes : undefined,
                peak: info ? info.cumulativeStack : undefined,
                peakBounded: info ? info.cumulativeBounded === true : false,
                recursive: info ? info.recursive === true : false
            });
            return;
        }
    }
    resolveQuery(name) {
        const state = this.deps.getState();
        const fn = state.byName.get(name);
        if (!fn || fn.ghost)
            return null;
        const info = state.depth.get(name);
        if (!info)
            return null;
        // Enumerate up to a larger cap than we show by default. The webview
        // displays pathsLimit initially and lets the user expand to all of
        // these on demand. We add +1 over the expanded cap purely to detect
        // "there are even more than this" for the badge.
        const EXPANDED_PATHS_CAP = 50;
        const pathDepth = state.pathsMaxDepth;
        const out = pathsFrom(state.byName, name, EXPANDED_PATHS_CAP + 1, pathDepth)
            .filter(p => p.nodes.length > 1);
        // pathsFrom is depth-capped and ranked by stack, so it can omit the
        // single deepest chain. Inject that chain (the path form of downDepth)
        // at the front so it survives the cap and "Calls into" sorted by hops
        // shows the same number as the Overview "Top by depth" list.
        const deepest = longestPathFrom(state.byName, name);
        if (deepest.nodes.length > 1) {
            const key = deepest.nodes.join(" ");
            const idx = out.findIndex(p => p.nodes.join(" ") === key);
            if (idx > 0) { out.splice(idx, 1); }
            if (idx !== 0) { out.unshift(deepest); }
        }
        const inn = pathsTo(state.byName, name, EXPANDED_PATHS_CAP + 1, pathDepth, state.pinnedRoots)
            .filter(p => p.nodes.length > 1);
        const isPinned = info.isPinnedRoot === true;
        const isAuto = info.isAutoRoot === true;
        // Recursion paths: cycles that start and end at this function. Only
        // computed when the function is actually in a cycle. Each cycle is a node
        // list n0=name → ... → name (the closing node repeated) so the UI can show
        // exactly which call chain loops back.
        const cycleResult = info.recursive
            ? this.findCycles(state.byName, name, 50, state.pathsMaxDepth)
            : { cycles: [], truncated: false, limitHit: null };
        const cycles = cycleResult.cycles;
        const perRoot = info.perRoot.map(e => ({
            rootName: e.rootName,
            rootFile: state.byName.get(e.rootName)?.file ?? "",
            rootIsPinned: state.pinnedRoots?.has(e.rootName) === true,
            isAuto: e.isAuto === true,
            depth: e.depth,
            cumulativeStack: e.cumulativeStack,
            cumulativeBounded: e.cumulativeBounded
        }));
        return {
            name,
            file: fn.file,
            nameLine: fn.nameLine,
            nameCol: fn.nameCol,
            depth: info.depth,
            recursive: info.recursive,
            recursiveViaFp: info.recursiveViaFp === true,
            fpVerified: info.fpVerified === true,
            fpSites: info.fpSites ?? [],
            pinnedRoot: isPinned,
            autoRoot: isAuto,
            stackBytes: fn.stackBytes,
            stackQualifier: fn.stackQualifier,
            cumulativeStack: info.cumulativeStack,
            cumulativeBounded: info.cumulativeBounded,
            perRoot,
            outgoing: out.slice(0, EXPANDED_PATHS_CAP).map(p => this.toDto(p, "from", state.pinnedRoots)),
            incoming: inn.slice(0, EXPANDED_PATHS_CAP).map(p => this.toDto(p, "to", state.pinnedRoots)),
            cycles: cycles.map(p => this.toDto(p, "from", state.pinnedRoots)),
            cyclesTruncated: cycleResult.truncated,
            cyclesLimitHit: cycleResult.limitHit,
            outgoingTotal: out.length,
            incomingTotal: inn.length,
            pathCap: EXPANDED_PATHS_CAP,
            thresholdWarn: state.thresholdWarn,
            thresholdCritical: state.thresholdCritical
        };
    }
    /** Find call cycles that start and end at `start`: chains
     *  start → a → b → … → start. Returned nodes include the closing `start`
     *  so the loop is explicit. Bounded by `limit` cycles and `maxDepth` hops. */
    findCycles(byName, start, limit, maxDepth) {
        const out = [];
        const frame = (n) => byName.get(n)?.stackBytes ?? 0;
        const stack = [start];
        const onPath = new Set([start]);
        // Enumerating all simple cycles is exponential. Three independent bounds
        // stop the search; we record WHICH one fired so the UI can say so:
        //   • "count"  — already collected `limit` (50) distinct cycle paths
        //   • "budget" — spent the DFS step budget (dense / fp-over-approx SCC)
        //   • "depth"  — a path got longer than depthCap hops before closing
        // depthCap follows pathsMaxDepth (so long-but-real loops are still found)
        // but is clamped to a sane ceiling to bound the search.
        const depthCap = Math.max(16, Math.min(maxDepth, 64));
        let budget = 40000;
        let limitHit = null;
        const mark = (why) => { if (!limitHit)
            limitHit = why; };
        const dfs = (node, depth) => {
            if (out.length >= limit) {
                mark('count');
                return false;
            }
            if (--budget <= 0) {
                mark('budget');
                return false;
            }
            if (depth > depthCap) {
                mark('depth');
                return true;
            }
            const rec = byName.get(node);
            if (!rec)
                return true;
            for (const c of rec.callees) {
                if (!byName.has(c))
                    continue;
                if (c === start) {
                    const nodes = [...stack, start];
                    const total = nodes.reduce((s, n, i) => i === nodes.length - 1 ? s : s + frame(n), 0);
                    out.push({ nodes, totalStack: total, truncatedByCycle: true });
                    if (out.length >= limit) {
                        mark('count');
                        return false;
                    }
                    continue;
                }
                if (onPath.has(c))
                    continue; // avoid unrelated sub-cycles
                onPath.add(c);
                stack.push(c);
                const cont = dfs(c, depth + 1);
                stack.pop();
                onPath.delete(c);
                if (!cont && (out.length >= limit || budget <= 0))
                    return false;
            }
            return true;
        };
        dfs(start, 1);
        // Guarantee at least one path: if the bounded enumeration above produced
        // nothing (it stopped on a limit before closing any loop — e.g. a very long
        // or very dense cycle), fall back to the SHORTEST cycle through `start`,
        // found by BFS. That is O(V+E), always terminates quickly, and finds a
        // minimal loop regardless of its length — so a recursive function with a
        // real cycle in the graph is never left with "no path to show".
        if (out.length === 0) {
            const sc = this.shortestCycle(byName, start);
            if (sc) {
                out.push(sc);
                // We still hit a limit for the FULL enumeration, but we have a path now,
                // so the UI shows the loop plus a "more cycles exist" hint rather than
                // an apology. Keep limitHit so "showing a subset" is accurate.
            }
        }
        // Shortest cycles first (most informative), then by stack.
        out.sort((a, b) => a.nodes.length - b.nodes.length || b.totalStack - a.totalStack);
        return { cycles: out, truncated: limitHit !== null, limitHit };
    }
    /** Shortest cycle start → … → start via BFS over callees. Always terminates
     *  in O(V+E); returns null only when no cycle through `start` exists in the
     *  recorded call edges. */
    shortestCycle(byName, start) {
        const frame = (n) => byName.get(n)?.stackBytes ?? 0;
        const prev = new Map(); // node → predecessor on BFS tree
        const queue = [];
        // Seed with start's direct callees (so we look for a path back to start
        // rather than the trivial zero-length "cycle").
        const startRec = byName.get(start);
        if (!startRec)
            return null;
        for (const c of startRec.callees) {
            if (c === start) { // direct self-recursion
                return { nodes: [start, start], totalStack: frame(start), truncatedByCycle: true };
            }
            if (byName.has(c) && !prev.has(c)) {
                prev.set(c, start);
                queue.push(c);
            }
        }
        let closer = null;
        while (queue.length) {
            const node = queue.shift();
            const rec = byName.get(node);
            if (!rec)
                continue;
            let done = false;
            for (const c of rec.callees) {
                if (c === start) {
                    closer = node;
                    done = true;
                    break;
                } // loop closes
                if (byName.has(c) && !prev.has(c)) {
                    prev.set(c, node);
                    queue.push(c);
                }
            }
            if (done)
                break;
        }
        if (closer === null)
            return null;
        // Reconstruct start → … → closer, then append start to close the loop.
        const rev = [closer];
        let cur = closer;
        while (cur !== start) {
            const p = prev.get(cur);
            if (p === undefined)
                break;
            rev.push(p);
            cur = p;
        }
        rev.reverse(); // now start → … → closer
        const nodes = [...rev, start]; // close the cycle
        const total = nodes.reduce((s, n, i) => i === nodes.length - 1 ? s : s + frame(n), 0);
        return { nodes, totalStack: total, truncatedByCycle: true };
    }
    toDto(p, kind, pinned) {
        // For "to" paths the root is nodes[0]; for "from" it's the function itself
        // (nodes[0]) — we still flag if nodes[0] happens to be pinned.
        return {
            nodes: p.nodes,
            rootIsPinned: pinned?.has(p.nodes[0]) === true,
            totalStack: p.totalStack,
            truncatedByCycle: p.truncatedByCycle,
            truncatedByDepth: p.truncatedByDepth === true
        };
    }
    getHtml(webview) {
        return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<title>Call Depth</title>
<style>
  :root { color-scheme: light dark; }
  * { box-sizing: border-box; }
  body {
    font-family: var(--vscode-font-family);
    font-size: var(--vscode-font-size);
    color: var(--vscode-foreground);
    background: var(--vscode-sideBar-background);
    margin: 0;
    padding: 8px 10px 16px;
  }
  .section-label {
    font-size: 11px; font-weight: 700; letter-spacing: 0.5px;
    color: var(--vscode-foreground);
    text-transform: uppercase;
    margin: 14px 2px 8px;
    padding-left: 8px;
    border-left: 3px solid var(--vscode-focusBorder);
    display: flex; align-items: center; gap: 6px; justify-content: space-between;
    min-height: 16px;
  }
  .section-label:first-of-type { margin-top: 4px; }
  .count {
    background: var(--vscode-badge-background);
    color: var(--vscode-badge-foreground);
    border-radius: 8px;
    padding: 0 6px;
    font-family: var(--vscode-editor-font-family);
    font-weight: 400;
    font-size: 10px;
    text-transform: none;
    letter-spacing: 0;
  }
  /* Search */
  input[type=text] {
    width: 100%;
    padding: 5px 8px;
    background: var(--vscode-input-background);
    color: var(--vscode-input-foreground);
    border: 1px solid var(--vscode-input-border, transparent);
    border-radius: 2px;
    font-family: var(--vscode-editor-font-family);
    font-size: 12px;
  }
  input[type=text]:focus { outline: 1px solid var(--vscode-focusBorder); outline-offset: -1px; }
  /* Custom suggestion dropdown — replaces <datalist> which doesn't behave
     reliably inside VS Code webviews (substring matches get dropped, the
     list silently truncates above N options). */
  .search-wrap { position: relative; }
  .suggestions {
    position: absolute; left: 0; right: 0; top: 100%;
    margin-top: 1px;
    max-height: 240px;
    overflow-y: auto;
    background: var(--vscode-editorWidget-background, var(--vscode-input-background));
    border: 1px solid var(--vscode-input-border, var(--vscode-panel-border));
    border-radius: 2px;
    z-index: 10;
    box-shadow: 0 2px 6px rgba(0,0,0,0.18);
  }
  .suggest-item {
    padding: 3px 8px;
    font-family: var(--vscode-editor-font-family);
    font-size: 12px;
    cursor: pointer;
    color: var(--vscode-foreground);
    display: flex; justify-content: space-between; align-items: baseline;
    gap: 8px;
  }
  .suggest-item.active,
  .suggest-item:hover { background: var(--vscode-list-activeSelectionBackground, var(--vscode-list-hoverBackground)); color: var(--vscode-list-activeSelectionForeground, inherit); }
  .suggest-item .match { font-weight: 600; }
  .suggest-item .badge-mini {
    font-size: 9px; opacity: 0.7;
  }
  .suggest-more {
    padding: 3px 8px;
    font-size: 11px;
    color: var(--vscode-descriptionForeground);
    font-style: italic;
  }
  /* Card */
  .card {
    background: var(--vscode-editor-background);
    border: 1px solid var(--vscode-panel-border);
    border-radius: 3px;
    padding: 8px 10px;
    margin-bottom: 6px;
    overflow: hidden;
  }
  .fn-row {
    display: flex; gap: 6px; align-items: center; margin-bottom: 8px;
    flex-wrap: wrap;
  }
  .fn-name {
    font-family: var(--vscode-editor-font-family);
    font-weight: 600; font-size: 13px;
  }
  .flag {
    font-size: 10px; padding: 1px 6px; border-radius: 8px; font-weight: 500;
  }
  .flag-rec   { background: rgba(226,75,74,0.20); color: var(--vscode-foreground); }
  .flag-rec-fp { background: rgba(230,160,30,0.22); color: var(--vscode-foreground); }
  .flag-pin   { background: rgba(127,119,221,0.25); color: var(--vscode-foreground); }
  .flag-auto  { background: rgba(38,139,46,0.18);  color: var(--vscode-foreground); }
  .flag-verified { background: rgba(38,139,46,0.28); color: var(--vscode-foreground); }
  .flag-ghost { background: rgba(128,128,128,0.20); color: var(--vscode-foreground); }
  .fp-sites { margin: 8px 0; }
  .fp-site { display: flex; align-items: baseline; gap: 6px; padding: 2px 0; font-size: 12px; }
  .fp-site .fp-mark { font-weight: 600; }
  .fp-site.bound .fp-mark { color: var(--vscode-charts-green, #2ea043); }
  .fp-site.approx .fp-mark { color: var(--vscode-charts-yellow, #d7a930); }
  .fp-site .fp-state { font-size: 10px; text-transform: uppercase; letter-spacing: 0.3px; opacity: 0.8; }
  .fp-site.bound .fp-state { color: var(--vscode-charts-green, #2ea043); }
  .fp-site.approx .fp-state { color: var(--vscode-charts-yellow, #d7a930); }
  .fp-site .fp-via { color: var(--vscode-textLink-foreground); }
  .fp-site .fp-loc { color: var(--vscode-descriptionForeground); font-size: 11px; }
  .fp-site .fp-loc-link { cursor: pointer; text-decoration: underline dotted; }
  .fp-site .fp-loc-link:hover { color: var(--vscode-textLink-foreground); }
  .fp-site .fp-tgts .fn-clickable { cursor: pointer; color: var(--vscode-textLink-foreground); }
  .fp-site .fp-tgts .fn-clickable:hover { text-decoration: underline; }
  .fp-site .fp-tgts { color: var(--vscode-descriptionForeground); }
  /* Stat grid */
  .stats {
    display: grid; grid-template-columns: repeat(3, 1fr); gap: 4px;
    margin-bottom: 6px;
  }
  .stat {
    background: var(--vscode-sideBarSectionHeader-background);
    border-radius: 3px;
    padding: 4px 6px;
  }
  .stat-label {
    font-size: 9px; font-weight: 600; letter-spacing: 0.4px;
    text-transform: uppercase;
    color: var(--vscode-descriptionForeground);
  }
  .stat-value {
    font-family: var(--vscode-editor-font-family);
    font-size: 12px; font-weight: 500;
  }
  .stat-value.ok   { color: rgb(120,180,80); }
  .stat-value.warn { color: rgb(212,170,60); }
  .stat-value.crit { color: rgb(230,90,90); }
  .stat-value.unk  { color: var(--vscode-descriptionForeground); }
  /* Per-root table */
  .per-root-tbl { width: 100%; table-layout: fixed; border-collapse: collapse; font-family: var(--vscode-editor-font-family); font-size: 11px; }
  .per-root-tbl th { text-align: left; padding: 4px 8px; color: var(--vscode-descriptionForeground); font-weight: 500; font-size: 10px; text-transform: uppercase; letter-spacing: 0.3px; border-bottom: 1px solid var(--vscode-panel-border); }
  .per-root-tbl th.sortable { cursor: pointer; user-select: none; }
  .per-root-tbl th.sortable:hover { color: var(--vscode-foreground); }
  .per-root-tbl td { padding: 4px 8px; border-bottom: 1px solid var(--vscode-panel-border); vertical-align: top; overflow: hidden; }
  .per-root-tbl tr:last-child td { border-bottom: 0; }
  .per-root-tbl code { background: transparent; padding: 0; }
  /* Fixed column widths so long root names / paths can't push the table past
     the panel edge. The root column flexes; the others are sized to content. */
  .per-root-tbl col.c-root  { width: auto; }
  .per-root-tbl col.c-depth { width: 48px; }
  .per-root-tbl col.c-peak  { width: 78px; }
  .per-root-tbl col.c-graph { width: 30px; }
  .per-root-tbl .root-link { overflow-wrap: anywhere; word-break: break-word; }
  .per-root-tbl .top-path { max-width: 100%; }
  .per-root-tbl col.c-depth + col, .per-root-tbl td:nth-child(2), .per-root-tbl td:nth-child(3) { white-space: nowrap; }
  .graph-jump { background: transparent; border: 1px solid var(--vscode-panel-border);
    color: var(--vscode-foreground); border-radius: 3px; cursor: pointer; font-size: 11px;
    padding: 0 5px; line-height: 16px; opacity: 0.6; }
  .graph-jump:hover { opacity: 1; background: var(--vscode-toolbar-hoverBackground); }
  /* File row */
  .file-row {
    display: flex; justify-content: space-between; align-items: center;
    font-size: 11px;
    color: var(--vscode-descriptionForeground);
  }
  .file-row .path-tail {
    font-family: var(--vscode-editor-font-family);
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  }
  .open-btn {
    background: transparent;
    color: var(--vscode-textLink-foreground);
    border: 0; cursor: pointer;
    text-decoration: underline;
    font-size: 11px; padding: 0; margin-left: 6px;
    font-family: var(--vscode-font-family);
  }
  .open-btn:hover { color: var(--vscode-textLink-activeForeground); }
  /* Path list */
  .path {
    background: var(--vscode-editor-background);
    border: 1px solid var(--vscode-panel-border);
    border-radius: 3px;
    padding: 5px 7px;
    margin-bottom: 4px;
  }
  .path-recursive {
    border-color: var(--vscode-charts-red, #e2504a);
    border-left-width: 3px;
    background: rgba(226,75,74,0.06);
  }
  .path-recursive .arrow { color: var(--vscode-charts-red, #e2504a); }
  .rec-path-note {
    font-size: 11px; line-height: 1.45; margin: 2px 0 6px;
    color: var(--vscode-descriptionForeground);
  }
  .path-chain {
    font-family: var(--vscode-editor-font-family);
    font-size: 11px; line-height: 1.55;
    word-break: break-all;
  }
  .path-chain .arrow { color: var(--vscode-descriptionForeground); margin: 0 3px; }
  .path-chain .fn-clickable {
    cursor: pointer;
    text-decoration: underline;
    text-decoration-color: transparent;
    transition: text-decoration-color 0.1s;
  }
  .path-chain .fn-clickable:hover {
    text-decoration-color: var(--vscode-textLink-foreground);
    color: var(--vscode-textLink-foreground);
  }
  .path-chain .fn-pinned {
    background: rgba(127,119,221,0.25);
    padding: 0 4px; border-radius: 3px;
  }
  .root-link {
    cursor: pointer;
    color: var(--vscode-textLink-foreground);
    text-decoration: underline;
    text-decoration-color: transparent;
    transition: text-decoration-color 0.1s;
    font-family: var(--vscode-editor-font-family);
  }
  .root-link:hover {
    text-decoration-color: var(--vscode-textLink-foreground);
  }
  .path-meta {
    display: flex; justify-content: space-between;
    font-size: 10px; margin-top: 3px;
    color: var(--vscode-descriptionForeground);
    font-family: var(--vscode-editor-font-family);
  }
  .cycle { color: rgb(230,90,90); }
  /* Recursion cycle — numbered steps + explicit loop-back line */
  .cycle-steps { margin: 4px 0 10px; padding-left: 2px; }
  .cycle-head { font-size: 10px; margin-bottom: 4px; color: var(--vscode-descriptionForeground); }
  .cycle-row { display: flex; align-items: baseline; gap: 8px; padding: 1px 0; line-height: 1.5; }
  .cycle-row .step-no {
    flex: 0 0 auto; min-width: 16px; text-align: right;
    color: var(--vscode-descriptionForeground); font-variant-numeric: tabular-nums;
    font-family: var(--vscode-editor-font-family); font-size: 11px;
  }
  .cycle-row .fn-clickable {
    cursor: pointer; color: var(--vscode-textLink-foreground);
    font-family: var(--vscode-editor-font-family);
  }
  .cycle-row .fn-clickable:hover { text-decoration: underline; }
  .cycle-row.cycle-back { margin-top: 2px; color: var(--vscode-descriptionForeground); }
  .cycle-row.cycle-back .step-no { color: rgb(230,90,90); }
  /* Chips (recent) */
  .chip-row { display: flex; flex-wrap: wrap; gap: 4px; padding: 0 2px; }
  .chip {
    background: var(--vscode-editor-background);
    border: 1px solid var(--vscode-panel-border);
    border-radius: 10px;
    padding: 2px 7px;
    font-family: var(--vscode-editor-font-family);
    font-size: 11px;
    cursor: pointer;
    color: var(--vscode-foreground);
  }
  .chip:hover { background: var(--vscode-list-hoverBackground); }
  /* Top list */
  .top-filter {
    width: 100%; box-sizing: border-box; margin: 2px 0 6px;
    padding: 3px 6px; font-size: 11px;
    font-family: var(--vscode-editor-font-family);
    color: var(--vscode-input-foreground);
    background: var(--vscode-input-background);
    border: 1px solid var(--vscode-input-border, var(--vscode-panel-border));
    border-radius: 2px; outline: none;
  }
  .top-filter:focus { border-color: var(--vscode-focusBorder); }
  .top-path {
    font-size: 10px; opacity: 0.6; margin-top: 1px;
    font-family: var(--vscode-editor-font-family);
    white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
    direction: rtl; text-align: left;   /* keep the tail (basename) visible */
  }
  .top-path b { color: var(--vscode-list-highlightForeground, var(--vscode-textLink-foreground)); font-weight: 600; opacity: 1; }
  .top-stat { display: flex; flex-direction: column; align-items: flex-end; flex: 0 0 auto; }
  .top-sub { font-size: 9px; opacity: 0.6; margin-top: 1px; white-space: nowrap; }
  .top-row {
    display: flex; justify-content: space-between; align-items: center;
    padding: 3px 6px;
    border-radius: 2px;
    font-family: var(--vscode-editor-font-family);
    font-size: 11px;
    cursor: pointer;
  }
  .top-row:hover { background: var(--vscode-list-hoverBackground); }
  .top-name { display: flex; align-items: center; gap: 4px; }
  .top-flag { font-size: 9px; opacity: 0.75; }
  .rec-tag { font-size: 9px; opacity: 0.7; color: var(--vscode-descriptionForeground);
    border: 1px solid var(--vscode-widget-border, rgba(128,128,128,0.3));
    border-radius: 3px; padding: 0 4px; }
  /* Empty/info */
  .empty {
    color: var(--vscode-descriptionForeground);
    font-size: 11px; padding: 8px 4px; line-height: 1.5;
  }
  .trunc-note {
    color: var(--vscode-inputValidation-warningForeground, #d90);
    background: var(--vscode-inputValidation-warningBackground, rgba(255,200,0,0.08));
    border: 1px solid var(--vscode-inputValidation-warningBorder, rgba(255,200,0,0.4));
    border-radius: 4px;
    font-size: 11px; padding: 5px 8px; margin: 4px 0 6px; line-height: 1.4;
  }
  #ctx-menu {
    position: fixed; z-index: 1000; display: none; min-width: 170px;
    background: var(--vscode-menu-background, var(--vscode-editor-background));
    color: var(--vscode-menu-foreground, var(--vscode-foreground));
    border: 1px solid var(--vscode-menu-border, var(--vscode-widget-border, rgba(128,128,128,0.35)));
    border-radius: 5px; padding: 4px 0;
    box-shadow: 0 2px 8px rgba(0,0,0,0.35); font-size: 12px;
  }
  #ctx-menu .ctx-title {
    padding: 4px 12px 6px; font-family: ui-monospace, monospace;
    color: var(--vscode-descriptionForeground); border-bottom: 1px solid
    var(--vscode-menu-separatorBackground, rgba(128,128,128,0.25));
    margin-bottom: 4px; max-width: 240px; overflow: hidden;
    text-overflow: ellipsis; white-space: nowrap;
  }
  #ctx-menu .ctx-item { padding: 5px 12px; cursor: pointer; white-space: nowrap; }
  #ctx-menu .ctx-item:hover {
    background: var(--vscode-menu-selectionBackground, var(--vscode-list-hoverBackground));
    color: var(--vscode-menu-selectionForeground, var(--vscode-foreground));
  }
  #ctx-menu .ctx-info-group { padding: 2px 0; }
  #ctx-menu .ctx-info { padding: 2px 12px; font-size: 11px; color: var(--vscode-descriptionForeground);
    font-family: var(--vscode-editor-font-family); white-space: nowrap; }
  #ctx-menu .ctx-sep { height: 1px; margin: 4px 0;
    background: var(--vscode-menu-separatorBackground, rgba(128,128,128,0.25)); }
  .hint {
    color: var(--vscode-descriptionForeground);
    font-size: 11px; padding: 0 2px;
  }
  .reveal-controls {
    display: flex;
    gap: 6px;
    margin: 4px 0 10px;
  }
  .reveal-btn {
    flex: 1;
    padding: 4px 8px;
    background: transparent;
    color: var(--vscode-textLink-foreground);
    border: 1px dashed var(--vscode-panel-border);
    border-radius: 4px;
    cursor: pointer;
    font-size: 11px;
    font-family: inherit;
    text-align: center;
    white-space: nowrap;
  }
  .reveal-btn:hover {
    background: var(--vscode-list-hoverBackground);
    border-style: solid;
  }
  /* Sort toggle (Callers / Calls into headers): stack vs hops. */
  .sort-ctl { display: inline-flex; gap: 2px; }
  .sort-btn {
    font-size: 10px; line-height: 15px; padding: 0 6px;
    background: transparent; color: var(--vscode-descriptionForeground);
    border: 1px solid var(--vscode-panel-border); border-radius: 3px;
    cursor: pointer; font-family: inherit; text-transform: none; letter-spacing: 0;
  }
  .sort-btn:hover { background: var(--vscode-list-hoverBackground); }
  .sort-btn.active {
    background: var(--vscode-button-background, var(--vscode-badge-background));
    color: var(--vscode-button-foreground, var(--vscode-badge-foreground));
    border-color: transparent;
  }
  /* Collapsible section headers (accordion). The arrow rotates; the content
     element (next sibling, or one marked data-collapse-body) toggles. */
  .section-label.collapsible { cursor: pointer; user-select: none; display: flex;
    align-items: center; gap: 6px; }
  .section-label.collapsible:hover { background: var(--vscode-list-hoverBackground); }
  .section-label.collapsed { border-left-color: var(--vscode-panel-border); }
  .section-label .twist { display: inline-block; width: 10px; font-size: 10px;
    transition: transform 0.12s ease; transform: rotate(90deg); flex: 0 0 auto;
    color: var(--vscode-focusBorder); }
  .section-label.collapsed .twist { transform: rotate(0deg); color: var(--vscode-descriptionForeground); }
  .section-label .count { margin-left: auto; }
  .collapse-body.hidden { display: none; }
  /* The collapsible body can also be a .reveal-wrap (caller/callee lists) or a
     trailing .reveal-controls; a generic rule hides whatever the toggle marks. */
  .hidden { display: none !important; }
  /* Tab bar separating the per-function detail view from the always-on,
     workspace-wide overview lists. */
  .tabbar { display: flex; gap: 4px; margin: 0 0 12px; border-bottom: 2px solid var(--vscode-panel-border); }
  .tab-btn {
    appearance: none; background: transparent; border: none;
    border-bottom: 3px solid transparent; cursor: pointer;
    color: var(--vscode-descriptionForeground);
    padding: 8px 14px; font-size: 13px; font-weight: 600; font-family: inherit;
    letter-spacing: 0.2px; margin-bottom: -2px;
    display: flex; align-items: center;
  }
  .tab-btn:hover { color: var(--vscode-foreground); background: var(--vscode-list-hoverBackground); border-top-left-radius: 4px; border-top-right-radius: 4px; }
  .tab-btn.active {
    color: var(--vscode-foreground);
    border-bottom-color: var(--vscode-focusBorder);
    background: var(--vscode-list-activeSelectionBackground, var(--vscode-list-hoverBackground));
    border-top-left-radius: 4px; border-top-right-radius: 4px;
  }
  .tab-btn .tab-badge {
    margin-left: 6px; font-size: 10px; font-weight: 600;
    background: var(--vscode-badge-background); color: var(--vscode-badge-foreground);
    border-radius: 9px; padding: 1px 7px;
  }
</style>
</head>
<body>
  <div class="tabbar" role="tablist">
    <button id="tab-function" class="tab-btn active" role="tab">Function</button>
    <button id="tab-overview" class="tab-btn" role="tab">Overview</button>
  </div>

  <!-- ── FUNCTION tab: search + per-function detail view ── -->
  <div id="function-tab" class="tab-panel">
    <div class="section-label" style="margin-top:0">
      Function lookup
      <span id="summary" class="count" style="display:none"></span>
    </div>
    <div class="search-wrap">
      <input id="q" type="text" placeholder="Type a function name…" autocomplete="off" spellcheck="false">
      <div id="suggestions" class="suggestions" style="display:none"></div>
    </div>
    <div id="status" class="hint" style="margin-top:6px">Loading analysis…</div>

    <div id="result"></div>

    <div id="recent-block" style="display:none">
      <div class="section-label">Recent lookups</div>
      <div id="recent" class="chip-row"></div>
    </div>

    <div id="function-empty" class="empty" style="display:none">
      Search for a function above, or pick one from the <a href="#" id="go-overview-link">Overview</a> tab.
    </div>
  </div>

  <!-- ── OVERVIEW tab: always-on, workspace-wide lists ── -->
  <div id="overview-tab" class="tab-panel" style="display:none">
    <div id="top-block" style="display:none">
      <div class="section-label collapsible" data-collapse="top"><span class="twist">▶</span>Top by peak stack <span id="top-count" class="count"></span></div>
      <div class="collapse-body" id="top-body">
        <input id="top-filter" class="top-filter" type="text" autocomplete="off" spellcheck="false"
               placeholder="Filter by path or name (e.g. src/drivers or /abs/path)" />
        <div id="top"></div>
      </div>
    </div>

    <div id="top-depth-block" style="display:none">
      <div class="section-label collapsible" data-collapse="top-depth"><span class="twist">▶</span>Top by depth <span id="top-depth-count" class="count"></span></div>
      <div class="collapse-body" id="top-depth-body">
        <div id="top-depth-note" class="hint" style="margin:2px 0 6px">Ranked by each function's deepest downward call chain (levels below it). A trailing + means a recursion cycle or the depth cap was hit.</div>
        <input id="top-depth-filter" class="top-filter" type="text" autocomplete="off" spellcheck="false"
               placeholder="Filter by path or name (e.g. src/drivers or /abs/path)" />
        <div id="top-depth"></div>
      </div>
    </div>

    <div id="top-frame-block" style="display:none">
      <div class="section-label collapsible" data-collapse="top-frame"><span class="twist">▶</span>Top by frame <span id="top-frame-count" class="count"></span></div>
      <div class="collapse-body" id="top-frame-body">
        <div id="top-frame-note" class="hint" style="margin:2px 0 6px">Ranked by each function's OWN stack frame (the -fstack-usage size), not the cumulative peak below it.</div>
        <input id="top-frame-filter" class="top-filter" type="text" autocomplete="off" spellcheck="false"
               placeholder="Filter by path or name (e.g. src/drivers or /abs/path)" />
        <div id="top-frame"></div>
      </div>
    </div>

    <div id="rec-block" style="display:none">
      <div class="section-label collapsible" data-collapse="rec"><span class="twist">▶</span>Recursive functions <span id="rec-count" class="count"></span></div>
      <div class="collapse-body" id="rec-body">
        <div id="rec-note" class="hint" style="margin:2px 0 6px">↻ certain (direct call) · ↻? possible (only via a function-pointer table — over-approximated)</div>
        <input id="rec-filter" class="top-filter" type="text" autocomplete="off" spellcheck="false" placeholder="Filter by path or name" />
        <div id="rec"></div>
      </div>
    </div>

    <div id="unbound-block" style="display:none">
      <div class="section-label collapsible" data-collapse="unbound"><span class="twist">▶</span>⚠ Unbound function pointers <span id="unbound-count" class="count"></span></div>
      <div class="collapse-body" id="unbound-body">
        <div id="unbound-note" class="hint" style="margin:2px 0 6px">Functions with fp call sites that no override covers — their stack rests on auto-inferred (over-approximated) targets. Use "Generate fp-overrides template" to verify.</div>
        <input id="unbound-filter" class="top-filter" type="text" autocomplete="off" spellcheck="false" placeholder="Filter by path or name" />
        <div id="unbound"></div>
      </div>
    </div>

    <div id="overview-empty" class="empty" style="display:none">No analysis yet.</div>
  </div>

  <div id="ctx-menu" role="menu">
    <div class="ctx-title" id="ctx-title"></div>
    <div class="ctx-info-group" id="ctx-info"></div>
    <div class="ctx-sep"></div>
    <div class="ctx-item" data-action="open">Open source</div>
    <div class="ctx-item" data-action="lookup">Show details in side panel</div>
    <div class="ctx-item" data-action="graph">Focus in call graph</div>
  </div>

<script>
  // Earliest possible error trap: if anything below throws before the panel
  // can signal ready, surface it in the status line instead of hanging
  // silently on "Loading analysis…".
  window.addEventListener('error', function (e) {
    try {
      var s = document.getElementById('status');
      if (s) { s.style.display = ''; s.textContent = 'Panel error: ' + (e.message || 'unknown'); }
    } catch (_) {}
  });
  const vscode = acquireVsCodeApi();
  // ── Tabs: "Function" (search + detail) vs "Overview" (workspace lists). ──
  const tabFunction = document.getElementById('tab-function');
  const tabOverview = document.getElementById('tab-overview');
  const functionTab = document.getElementById('function-tab');
  const overviewTab = document.getElementById('overview-tab');
  function switchTab(which, persist) {
    const fn = which === 'function';
    if (functionTab) functionTab.style.display = fn ? '' : 'none';
    if (overviewTab) overviewTab.style.display = fn ? 'none' : '';
    if (tabFunction) tabFunction.classList.toggle('active', fn);
    if (tabOverview) tabOverview.classList.toggle('active', !fn);
    if (persist !== false) { try { const s = vscode.getState() || {}; s.tab = which; vscode.setState(s); } catch (_) {} }
    if (fn && q) { try { q.focus(); } catch (_) {} }
  }
  if (tabFunction) tabFunction.addEventListener('click', () => switchTab('function'));
  if (tabOverview) tabOverview.addEventListener('click', () => switchTab('overview'));
  // Persist the open function across webview teardown/reload (switching to
  // another sidebar view and back). saveOpenFn writes it into the webview's
  // retained state; on boot we re-query it so the detail view is restored.
  function saveOpenFn(name) {
    try {
      const s = vscode.getState() || {};
      s.openFn = name || '';
      vscode.setState(s);
    } catch (_) {}
  }
  function persistedOpenFn() {
    try { return (vscode.getState() || {}).openFn || ''; } catch (_) { return ''; }
  }
  const q = document.getElementById('q');
  const suggestions = document.getElementById('suggestions');
  const result = document.getElementById('result');
  const status = document.getElementById('status');
  const summary = document.getElementById('summary');
  const recentBlock = document.getElementById('recent-block');
  const recentDiv = document.getElementById('recent');
  const topBlock = document.getElementById('top-block');
  const topDiv = document.getElementById('top');
  const topCount = document.getElementById('top-count');
  const topFilter = document.getElementById('top-filter');
  var topEntries = [];           // full ranked list (with file paths)
  var TOP_VIEW_LIMIT = 10;       // shown when no filter is active
  const topDepthBlock = document.getElementById('top-depth-block');
  const topDepthDiv = document.getElementById('top-depth');
  const topDepthCount = document.getElementById('top-depth-count');
  const topDepthFilter = document.getElementById('top-depth-filter');
  var topDepthEntries = [];      // full ranked-by-depth list
  const topFrameBlock = document.getElementById('top-frame-block');
  const topFrameDiv = document.getElementById('top-frame');
  const topFrameCount = document.getElementById('top-frame-count');
  const topFrameFilter = document.getElementById('top-frame-filter');
  var topFrameEntries = [];      // full ranked-by-own-frame list
  const recBlock = document.getElementById('rec-block');
  const recDiv = document.getElementById('rec');
  const recCount = document.getElementById('rec-count');
  const recFilter = document.getElementById('rec-filter');
  const unboundBlock = document.getElementById('unbound-block');
  const unboundDiv = document.getElementById('unbound');
  const unboundCount = document.getElementById('unbound-count');
  const unboundFilter = document.getElementById('unbound-filter');

  // ── Right-click context menu for function items in caller/callee lists ──
  const ctxMenu = document.getElementById('ctx-menu');
  const ctxTitle = document.getElementById('ctx-title');
  let ctxTarget = null;  // the function name the menu was opened on
  // Cache of hover-tooltip text per function (filled lazily on first hover via
  // requestFnInfo). Keeps tooltips instant on repeat hovers.
  const fnInfoCache = {};
  // Last path segment, splitting on both separators without a regex literal
  // (a backslash regex inside this template literal would break the webview JS).
  function baseName(p) {
    let s = String(p);
    let i = Math.max(s.lastIndexOf('/'), s.lastIndexOf(String.fromCharCode(92)));
    return i >= 0 ? s.slice(i + 1) : s;
  }

  function showCtxMenu(x, y, name) {
    ctxTarget = name;
    ctxTitle.textContent = name;
    // Reset info; request fresh frame/peak for this function from the host so
    // the menu shows the same Frame/Peak the graph menu does (info ≠ actions).
    const info = document.getElementById('ctx-info');
    if (info) info.innerHTML = '<div class="ctx-info">Frame: …</div><div class="ctx-info">Peak: …</div>';
    vscode.postMessage({ type: 'requestFnInfo', name: name });
    ctxMenu.style.display = 'block';
    // Position, keeping the menu within the viewport.
    const mw = ctxMenu.offsetWidth || 180;
    const mh = ctxMenu.offsetHeight || 110;
    const px = Math.min(x, window.innerWidth - mw - 4);
    const py = Math.min(y, window.innerHeight - mh - 4);
    ctxMenu.style.left = Math.max(2, px) + 'px';
    ctxMenu.style.top = Math.max(2, py) + 'px';
  }
  function hideCtxMenu() {
    ctxMenu.style.display = 'none';
    ctxTarget = null;
  }
  for (const item of ctxMenu.querySelectorAll('.ctx-item')) {
    item.addEventListener('click', () => {
      const action = item.getAttribute('data-action');
      const name = ctxTarget;
      hideCtxMenu();
      if (!name) return;
      if (action === 'lookup') {
        const q = document.getElementById('q');
        if (q) q.value = name;
        vscode.postMessage({ type: 'query', name: name });
      } else if (action === 'open') {
        vscode.postMessage({ type: 'goto', name: name });
      } else if (action === 'graph') {
        vscode.postMessage({ type: 'graph', name: name });
      }
    });
  }
  // Dismiss on any outside click, scroll, Escape, or window blur.
  document.addEventListener('click', (e) => {
    if (ctxMenu.style.display === 'block' && !ctxMenu.contains(e.target)) hideCtxMenu();
  });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') hideCtxMenu(); });
  window.addEventListener('blur', hideCtxMenu);
  window.addEventListener('scroll', hideCtxMenu, true);

  let names = [];
  let recent = [];
  let thresholds = { warn: 1024, critical: 4096 };
  let pathsLimit = 5;
  let lastSummaryTotal = -1;
  // Name of the function currently shown in the detail view, so a re-analysis
  // can refresh it automatically (its stack/peak/paths may have changed).
  let currentOpenFn = '';
  // True while the next 'result' is from an automatic re-query (analysis
  // refresh / restore), not a user lookup — so render() won't yank the user off
  // the Overview tab.
  let pendingAutoRequery = false;
  // Per-root table sort state. key: 'root' | 'depth' | 'peak'; dir: 1 asc / -1 desc.
  let currentPerRoot = null;
  let lastDetail = null;        // last rendered function payload (for re-sort)
  let callersSort = 'stack';    // 'stack' | 'hops' — Callers section sort
  let callsIntoSort = 'stack';  // 'stack' | 'hops' — Calls into section sort
  let perRootSort = { key: 'peak', dir: -1 };
  let perRootFilter = '';   // absolute-path / name filter for the per-root table
  // Custom suggestion state
  const SUGGEST_LIMIT = 100;
  let currentMatches = [];
  let activeIndex = -1;

  // "Overview" link in the empty Function tab.
  const goOverviewLink = document.getElementById('go-overview-link');
  if (goOverviewLink) goOverviewLink.addEventListener('click', (e) => { e.preventDefault(); switchTab('overview'); });

  // Restore the last-used tab (default: Function).
  (function () {
    let saved = 'function';
    try { saved = (vscode.getState() || {}).tab || 'function'; } catch (_) {}
    switchTab(saved, false);
  })();

  vscode.postMessage({ type: 'ready' });

  window.addEventListener('message', (ev) => {
    const m = ev.data;
    if (m.type === 'fnInfo') {
      // Cache for hover tooltips, and fill the context menu's info section.
      const frameTxt = (m.frame === undefined || m.frame === null) ? '?' : fmtBytes(m.frame);
      const peakTxt = (m.peak === undefined || m.peak === null) ? '?' : fmtBytes(m.peak) + (m.peakBounded ? '+' : '');
      const recTxt = m.recursive ? ' · recursive ↻' : '';
      const base = m.file ? baseName(m.file) : '';
      const fileTxt = base ? ' · ' + base : '';
      const titleText = m.name + ' — Frame: ' + frameTxt + ' · Peak: ' + peakTxt + recTxt + fileTxt;
      fnInfoCache[m.name] = titleText;
      // Update any visible function links for this name with the richer tooltip.
      for (const el of document.querySelectorAll('[data-fn="' + m.name + '"]')) {
        el.setAttribute('title', titleText);
      }
      // Fill the context menu's info section if the menu is open on this fn.
      const info = document.getElementById('ctx-info');
      if (info && m.name === ctxTarget) {
        let h = '<div class="ctx-info">Frame: ' + frameTxt + '</div>' +
                '<div class="ctx-info">Peak: ' + peakTxt + recTxt + '</div>';
        if (base) h += '<div class="ctx-info">File: ' + base + '</div>';
        info.innerHTML = h;
      }
      return;
    }
    if (m.type === 'names') {
      // Just store. We do match-filtering on input rather than dumping the
      // entire list into the DOM up front (large workspaces have thousands
      // of symbols; rendering them all is wasteful and used to hit
      // datalist truncation limits).
      names = m.names;
    } else if (m.type === 'state') {
      if (m.thresholds) thresholds = m.thresholds;
      if (typeof m.pathsLimit === 'number') pathsLimit = m.pathsLimit;
      if (m.summary) {
        lastSummaryTotal = m.summary.total;
        if (m.summary.total > 0) {
          summary.style.display = '';
          summary.textContent = m.summary.total + ' fn · ' + m.summary.withStack + ' w/ stack';
          status.style.display = 'none';
        } else {
          status.style.display = '';
          status.textContent = 'No analysis available yet.';
        }
      }
    } else if (m.type === 'top') {
      renderTop(m.entries);
    } else if (m.type === 'topDepth') {
      renderTopDepth(m.entries);
    } else if (m.type === 'topFrame') {
      renderTopFrame(m.entries);
    } else if (m.type === 'unboundFp') {
      renderUnboundFp(m.entries);
    } else if (m.type === 'recursion') {
      renderRecursion(m.entries);
      // Safety net: if the summary said there is data, make sure the loading
      // text is cleared even if the 'state' message arrived out of order.
      if (lastSummaryTotal > 0) { summary.style.display = ''; status.style.display = 'none'; }
      // This message is the last step of an analysis update. If a function's
      // detail view is currently open, re-query it so its stack/peak/paths
      // reflect the new analysis automatically (no manual re-search needed).
      // If nothing is open but a function was open before the webview was torn
      // down (view switch), restore it from persisted state.
      if (currentOpenFn) {
        pendingAutoRequery = true;
        vscode.postMessage({ type: 'query', name: currentOpenFn });
      } else {
        const saved = persistedOpenFn();
        if (saved) {
          currentOpenFn = saved;
          pendingAutoRequery = true;
          vscode.postMessage({ type: 'query', name: saved });
        }
      }
    } else if (m.type === 'result') {
      const auto = pendingAutoRequery; pendingAutoRequery = false;
      render(m.payload, auto);
    } else if (m.type === 'externalQuery') {
      // Triggered by the hover's "open in side panel" link. Fill the search
      // box and run the query, just as if the user had typed it.
      if (typeof m.name === 'string' && m.name) {
        q.value = m.name;
        suggestions.style.display = 'none';
        pushRecent(m.name);
        vscode.postMessage({ type: 'query', name: m.name });
      }
    }
  });

  function computeMatches(query) {
    if (!query) return [];
    const lower = query.toLowerCase();
    const startsWith = [];
    const contains = [];
    for (const n of names) {
      const nl = n.toLowerCase();
      if (nl === lower) {
        // exact match — push first
        startsWith.unshift(n);
      } else if (nl.startsWith(lower)) {
        startsWith.push(n);
      } else if (nl.includes(lower)) {
        contains.push(n);
      }
    }
    // Prefer prefix matches, then substring. Names are already sorted.
    return startsWith.concat(contains);
  }

  function renderSuggestions() {
    if (currentMatches.length === 0) {
      suggestions.style.display = 'none';
      activeIndex = -1;
      return;
    }
    const shown = currentMatches.slice(0, SUGGEST_LIMIT);
    const more = currentMatches.length - shown.length;
    const queryLower = q.value.trim().toLowerCase();
    let html = '';
    for (let i = 0; i < shown.length; i++) {
      const n = shown[i];
      const escName = escape(n);
      // Highlight the matched substring
      const lower = n.toLowerCase();
      const idx = lower.indexOf(queryLower);
      let label;
      if (idx >= 0 && queryLower.length > 0) {
        const before = escape(n.slice(0, idx));
        const mid = escape(n.slice(idx, idx + queryLower.length));
        const after = escape(n.slice(idx + queryLower.length));
        label = before + '<span class="match">' + mid + '</span>' + after;
      } else {
        label = escName;
      }
      const cls = (i === activeIndex) ? 'suggest-item active' : 'suggest-item';
      html += '<div class="' + cls + '" data-idx="' + i + '" data-name="' + escName + '">';
      html += '<span>' + label + '</span>';
      html += '</div>';
    }
    if (more > 0) {
      html += '<div class="suggest-more">+' + more + ' more — keep typing to narrow</div>';
    }
    suggestions.innerHTML = html;
    suggestions.style.display = '';
    // Hook click events. Use mousedown rather than click so the input
    // doesn't lose focus between mousedown and click (which would close
    // the dropdown before the click registers).
    for (const el of suggestions.querySelectorAll('[data-name]')) {
      el.addEventListener('mousedown', (e) => {
        e.preventDefault(); // keep focus on input
        const name = el.getAttribute('data-name');
        chooseSuggestion(name);
      });
      el.addEventListener('mouseenter', () => {
        const idx = parseInt(el.getAttribute('data-idx'), 10);
        setActive(idx);
      });
    }
    // Scroll active into view
    if (activeIndex >= 0) {
      const activeEl = suggestions.querySelector('.suggest-item.active');
      if (activeEl) activeEl.scrollIntoView({ block: 'nearest' });
    }
  }

  function setActive(idx) {
    if (idx === activeIndex) return;
    const items = suggestions.querySelectorAll('.suggest-item');
    if (activeIndex >= 0 && items[activeIndex]) items[activeIndex].classList.remove('active');
    activeIndex = idx;
    if (activeIndex >= 0 && items[activeIndex]) {
      items[activeIndex].classList.add('active');
      items[activeIndex].scrollIntoView({ block: 'nearest' });
    }
  }

  function chooseSuggestion(name) {
    q.value = name;
    suggestions.style.display = 'none';
    activeIndex = -1;
    vscode.postMessage({ type: 'query', name });
  }

  q.addEventListener('input', () => {
    const v = q.value.trim();
    if (!v) {
      result.innerHTML = '';
      currentMatches = [];
      renderSuggestions();
      return;
    }
    currentMatches = computeMatches(v);
    activeIndex = currentMatches.length > 0 ? 0 : -1;
    renderSuggestions();
  });

  // Path/name filter for the Top-by-peak list. Re-renders on each keystroke;
  // Escape clears it.
  if (topFilter) {
    topFilter.addEventListener('input', () => renderTop());
    topFilter.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') { topFilter.value = ''; renderTop(); }
    });
  }
  if (topDepthFilter) {
    topDepthFilter.addEventListener('input', () => renderTopDepth());
    topDepthFilter.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') { topDepthFilter.value = ''; renderTopDepth(); }
    });
  }
  if (topFrameFilter) {
    topFrameFilter.addEventListener('input', () => renderTopFrame());
    topFrameFilter.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') { topFrameFilter.value = ''; renderTopFrame(); }
    });
  }
  if (recFilter) {
    recFilter.addEventListener('input', () => renderRecursion());
    recFilter.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') { recFilter.value = ''; renderRecursion(); }
    });
  }
  if (unboundFilter) {
    unboundFilter.addEventListener('input', () => renderUnboundFp());
    unboundFilter.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') { unboundFilter.value = ''; renderUnboundFp(); }
    });
  }

  q.addEventListener('keydown', (e) => {
    const visible = suggestions.style.display !== 'none' && currentMatches.length > 0;
    const count = Math.min(currentMatches.length, SUGGEST_LIMIT);
    if (e.key === 'ArrowDown') {
      if (visible) {
        e.preventDefault();
        // Wrap to the top when moving past the last item.
        const next = activeIndex < 0 ? 0 : (activeIndex + 1) % count;
        setActive(next);
      }
    } else if (e.key === 'ArrowUp') {
      if (visible) {
        e.preventDefault();
        // Wrap to the bottom when moving above the first item.
        const prev = activeIndex <= 0 ? count - 1 : activeIndex - 1;
        setActive(prev);
      }
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (visible && activeIndex >= 0) {
        chooseSuggestion(currentMatches[activeIndex]);
      } else {
        const v = q.value.trim();
        if (v) vscode.postMessage({ type: 'query', name: v });
      }
    } else if (e.key === 'Escape') {
      suggestions.style.display = 'none';
      activeIndex = -1;
    }
  });

  q.addEventListener('focus', () => {
    const v = q.value.trim();
    if (v && currentMatches.length > 0) renderSuggestions();
  });

  q.addEventListener('blur', () => {
    // Delay to let any mousedown handler fire first
    setTimeout(() => {
      suggestions.style.display = 'none';
    }, 150);
  });

  function fmtBytes(n) {
    if (n === undefined || n === null) return '?';
    if (n < 1024) return n + 'B';
    if (n < 1024 * 1024) return (n / 1024).toFixed(1) + 'KB';
    return (n / (1024 * 1024)).toFixed(1) + 'MB';
  }

  function sevClass(stack) {
    if (stack === undefined || stack === null) return 'unk';
    if (stack <= thresholds.warn) return 'ok';
    if (stack <= thresholds.critical) return 'warn';
    return 'crit';
  }

  function escape(s) {
    return String(s).replace(/[&<>"']/g, c =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  }

  function renderChain(nodes, rootIsPinned) {
    return nodes.map((n, i) => {
      const cls = (i === 0 && rootIsPinned) ? 'fn-clickable fn-pinned' : 'fn-clickable';
      return '<span class="' + cls + '" data-fn="' + escape(n) + '">' + escape(n) + '</span>';
    }).join('<span class="arrow">→</span>');
  }

  function renderPaths(paths, recursive) {
    if (!paths || paths.length === 0) return '<div class="empty">none</div>';
    let html = '';
    for (const p of paths) {
      html += '<div class="path' + (recursive ? ' path-recursive' : '') + '">';
      html += '<div class="path-chain">' + renderChain(p.nodes, p.rootIsPinned) + '</div>';
      html += '<div class="path-meta">';
      html += '<span>total ' + fmtBytes(p.totalStack) + '</span>';
      if (recursive) {
        html += '<span>' + (p.nodes.length - 1) + ' hops · <span class="cycle">↻ loop</span></span>';
      } else {
        // ↻ ONLY when the chain hit a real recursion cycle; a depth-limit cut is
        // shown as "…" (the chain continues past what is listed), never as ↻.
        const mark = p.truncatedByCycle ? ' · <span class="cycle">↻</span>'
                   : p.truncatedByDepth ? ' · <span class="hint" title="chain continues past the depth limit (cCallDepth.maxDepthForCumulative)">…</span>'
                   : '';
        html += '<span>' + p.nodes.length + ' hops' + mark + '</span>';
      }
      html += '</div></div>';
    }
    return html;
  }

  // Recursion cycles, shown as NUMBERED steps with an explicit loop-back line —
  // clearer than a horizontal "A → B → C → A" chain (no repeated node; the loop
  // closure is spelled out). cycle nodes close on the start (nodes[last] ===
  // nodes[0]); we drop that repeat for numbering and reference it in the footer.
  function renderCyclePaths(paths) {
    if (!paths || paths.length === 0) return '<div class="empty">none</div>';
    let html = '';
    for (const p of paths) {
      const nodes = p.nodes.slice();
      let loopTo = 0;
      if (nodes.length >= 2 && nodes[nodes.length - 1] === nodes[0]) {
        nodes.pop();                                   // drop the closing repeat of the start
      } else if (nodes.length >= 2) {
        const li = nodes.slice(0, -1).indexOf(nodes[nodes.length - 1]);
        if (li >= 0) { loopTo = li; nodes.pop(); }     // closes on an interior node (rare)
      }
      const hops = p.nodes.length - 1;
      const fn = (n, pinned) => '<span class="fn-clickable' + (pinned ? ' fn-pinned' : '') +
        '" data-fn="' + escape(n) + '">' + escape(n) + '</span>';
      html += '<div class="path path-recursive cycle-steps">';
      html += '<div class="cycle-head"><span class="cycle">↻ loop</span> · ' +
        hops + ' hops · total ' + fmtBytes(p.totalStack) + '</div>';
      for (let i = 0; i < nodes.length; i++) {
        html += '<div class="cycle-row"><span class="step-no">' + (i + 1) + '</span>' +
          fn(nodes[i], i === 0 && p.rootIsPinned) + '</div>';
      }
      html += '<div class="cycle-row cycle-back"><span class="step-no">↺</span>' +
        '<span>back to ' + (loopTo + 1) + ' · ' + fn(nodes[loopTo], false) + '</span></div>';
      html += '</div>';
    }
    return html;
  }

  function pushRecent(name) {
    recent = [name, ...recent.filter(n => n !== name)].slice(0, 6);
    renderRecent();
  }

  function renderRecent() {
    if (recent.length === 0) { recentBlock.style.display = 'none'; return; }
    recentBlock.style.display = '';
    recentDiv.innerHTML = recent.map(n =>
      '<span class="chip" data-recent="' + escape(n) + '">' + escape(n) + '</span>'
    ).join('');
    for (const el of recentDiv.querySelectorAll('[data-recent]')) {
      el.addEventListener('click', () => {
        q.value = el.getAttribute('data-recent');
        vscode.postMessage({ type: 'query', name: q.value });
      });
    }
  }

  const REC_INITIAL = 8;
  var recEntries = [];
  function renderRecursion(entries) {
    if (entries) recEntries = entries;
    if (!recEntries || recEntries.length === 0) { recBlock.style.display = 'none'; return; }
    recBlock.style.display = '';
    const all = recEntries;
    const certain = all.filter(e => !e.viaFp).length;
    const possible = all.length - certain;
    const filter = (recFilter && recFilter.value || '').trim().toLowerCase();
    const list = filter
      ? all.filter(e => ((e.file || '').toLowerCase().indexOf(filter) !== -1) ||
                        (e.name.toLowerCase().indexOf(filter) !== -1))
      : all;
    recCount.textContent = filter
      ? (list.length + ' match' + (list.length === 1 ? '' : 'es'))
      : (certain + ' certain' + (possible ? ', ' + possible + ' possible' : ''));
    if (list.length === 0) {
      recDiv.innerHTML = '<div class="empty">No recursive function matches that path or name.</div>';
      wireCollapsibles(recBlock); return;
    }
    const rows = list.map(e => {
      const flag = e.viaFp
        ? '<span class="top-flag" title="possible — cycle only via function-pointer table (over-approximated)">↻?</span>'
        : '<span class="top-flag" title="certain — direct call participates in the cycle">↻</span>';
      const sev = sevClass(e.peak);
      const pathRow = (filter && e.file)
        ? '<div class="top-path" title="' + escape(e.file) + '">' + highlight(e.file, filter) + '</div>' : '';
      // Cycle length: 1 = direct self-recursion, 2 = mutual (a↔b), N = N-hop loop.
      const hopTxt = e.hops > 0
        ? (e.hops === 1 ? 'self' : e.hops + ' hops')
        : '';
      const hopSub = hopTxt
        ? '<div class="top-sub" title="Length of the shortest cycle through this function">' + hopTxt + '</div>'
        : '';
      return '<div class="top-row" data-top="' + escape(e.name) + '">' +
        '<div style="min-width:0;flex:1">' +
        '<div class="top-name">' + escape(e.name) + ' ' + flag +
        (e.viaFp ? ' <span class="rec-tag">via fn-ptr</span>' : '') + '</div>' + pathRow +
        '</div>' +
        '<div class="top-stat">' +
          '<div class="stat-value ' + sev + '">' + fmtBytes(e.peak) + '</div>' +
          hopSub +
        '</div>' +
        '</div>';
    }).join('');
    // When filtering, show every match (no incremental reveal); otherwise the
    // first batch with show-more controls.
    let html;
    if (filter) {
      html = '<div class="reveal-wrap" data-visible="' + list.length + '" data-total="' + list.length + '">' + rows + '</div>';
    } else {
      const initial = Math.min(REC_INITIAL, list.length);
      html = '<div class="reveal-wrap" data-visible="' + initial + '" data-total="' + list.length + '">' + rows + '</div>';
      if (list.length > initial) {
        html += '<div class="reveal-controls">' +
          '<button class="reveal-btn" data-reveal="step">show ' + Math.min(10, list.length - initial) + ' more</button>' +
          '<button class="reveal-btn" data-reveal="all">show all (' + list.length + ')</button>' +
          '<button class="reveal-btn" data-reveal="less" style="display:none">show less</button>' +
          '</div>';
      }
    }
    recDiv.innerHTML = html;
    for (const el of recDiv.querySelectorAll('[data-top]')) {
      el.addEventListener('click', () => {
        q.value = el.getAttribute('data-top');
        vscode.postMessage({ type: 'query', name: q.value });
      });
    }
    wireRevealControls(recDiv);
    wireCollapsibles(recBlock);
  }

  const UNBOUND_INITIAL = 8;
  var unboundEntries = [];
  function renderUnboundFp(entries) {
    if (entries) unboundEntries = entries;
    if (!unboundEntries || unboundEntries.length === 0) { unboundBlock.style.display = 'none'; return; }
    unboundBlock.style.display = '';
    const all = unboundEntries;
    const filter = (unboundFilter && unboundFilter.value || '').trim().toLowerCase();
    const list = filter
      ? all.filter(e => ((e.file || '').toLowerCase().indexOf(filter) !== -1) ||
                        (e.name.toLowerCase().indexOf(filter) !== -1))
      : all;
    const totalSites = list.reduce((a, e) => a + (e.sites || 0), 0);
    unboundCount.textContent = filter
      ? (list.length + ' match' + (list.length === 1 ? '' : 'es'))
      : (all.length + ' fn, ' + totalSites + ' site' + (totalSites === 1 ? '' : 's'));
    if (list.length === 0) {
      unboundDiv.innerHTML = '<div class="empty">No unbound-fp function matches that path or name.</div>';
      wireCollapsibles(unboundBlock); return;
    }
    const rows = list.map(e => {
      const sev = sevClass(e.peak);
      const n = e.sites > 1 ? ' <span class="rec-tag">' + e.sites + ' sites</span>' : '';
      const pathRow = (filter && e.file)
        ? '<div class="top-path" title="' + escape(e.file) + '">' + highlight(e.file, filter) + '</div>' : '';
      return '<div class="top-row" data-top="' + escape(e.name) + '">' +
        '<div style="min-width:0;flex:1">' +
        '<div class="top-name"><span class="fp-mark" style="color:var(--vscode-charts-yellow,#d7a930)">⚠</span> ' +
        escape(e.name) + n + '</div>' + pathRow +
        '</div>' +
        '<div class="stat-value ' + sev + '">' + fmtBytes(e.peak) + '</div>' +
        '</div>';
    }).join('');
    let html;
    if (filter) {
      html = '<div class="reveal-wrap" data-visible="' + list.length + '" data-total="' + list.length + '">' + rows + '</div>';
    } else {
      const initial = Math.min(UNBOUND_INITIAL, list.length);
      html = '<div class="reveal-wrap" data-visible="' + initial + '" data-total="' + list.length + '">' + rows + '</div>';
      if (list.length > initial) {
        html += '<div class="reveal-controls">' +
          '<button class="reveal-btn" data-reveal="step">show ' + Math.min(10, list.length - initial) + ' more</button>' +
          '<button class="reveal-btn" data-reveal="all">show all (' + list.length + ')</button>' +
          '<button class="reveal-btn" data-reveal="less" style="display:none">show less</button>' +
          '</div>';
      }
    }
    unboundDiv.innerHTML = html;
    for (const el of unboundDiv.querySelectorAll('[data-top]')) {
      el.addEventListener('click', () => {
        q.value = el.getAttribute('data-top');
        vscode.postMessage({ type: 'query', name: q.value });
      });
    }
    wireRevealControls(unboundDiv);
    wireCollapsibles(unboundBlock);
  }

  function renderTop(entries) {
    if (entries) topEntries = entries;
    // Reflect the overview's size on the tab so users know it's populated.
    if (tabOverview) {
      const n = (topEntries && topEntries.length) || 0;
      tabOverview.innerHTML = 'Overview' + (n ? ' <span class="tab-badge">' + n + '</span>' : '');
    }
    if (!topEntries || topEntries.length === 0) { topBlock.style.display = 'none'; return; }
    topBlock.style.display = '';
    const filter = (topFilter && topFilter.value || '').trim().toLowerCase();
    let list = topEntries;
    if (filter) {
      // Match against the absolute file path OR the function name. Path match
      // is the primary use (filter a directory / file); name match is a bonus.
      list = topEntries.filter(e =>
        ((e.file || '').toLowerCase().indexOf(filter) !== -1) ||
        (e.name.toLowerCase().indexOf(filter) !== -1));
    }
    const shown = filter ? list : list.slice(0, TOP_VIEW_LIMIT);
    topCount.textContent = filter
      ? (list.length + ' match' + (list.length === 1 ? '' : 'es'))
      : topEntries.length;
    if (shown.length === 0) {
      topDiv.innerHTML = '<div class="empty">No function matches that path or name.</div>';
      return;
    }
    topDiv.innerHTML = shown.map(e => {
      const sev = sevClass(e.peak);
      const tags = [];
      if (e.recursive) tags.push('<span class="top-flag" title="' +
        (e.recursiveViaFp ? 'possible recursion (via fn-ptr)' : 'certain recursion') +
        '">' + (e.recursiveViaFp ? '↻?' : '↻') + '</span>');
      if (e.pinnedRoot) tags.push('<span class="top-flag">📌</span>');
      else if (e.autoRoot) tags.push('<span class="top-flag">⚓</span>');
      // When filtering, show the path (with the matched part highlighted) so
      // it's clear WHY each row matched and which file it lives in.
      let pathRow = '';
      if (filter && e.file) {
        pathRow = '<div class="top-path" title="' + escape(e.file) + '">' +
          highlight(e.file, filter) + '</div>';
      }
      return '<div class="top-row" data-top="' + escape(e.name) + '">' +
        '<div style="min-width:0;flex:1">' +
          '<div class="top-name">' + escape(e.name) + ' ' + tags.join('') + '</div>' +
          pathRow +
        '</div>' +
        '<div class="stat-value ' + sev + '">' + fmtBytes(e.peak) + (e.bounded ? '+' : '') + '</div>' +
        '</div>';
    }).join('');
    for (const el of topDiv.querySelectorAll('[data-top]')) {
      el.addEventListener('click', () => {
        q.value = el.getAttribute('data-top');
        vscode.postMessage({ type: 'query', name: q.value });
      });
    }
    wireCollapsibles(topBlock);
  }

  // Top-by-depth list — mirrors renderTop but ranks by each function's deepest
  // downward call chain (levels), shown as "d:N" on the right. The Overview tab
  // badge is owned by renderTop, so this does not touch it.
  function renderTopDepth(entries) {
    if (entries) topDepthEntries = entries;
    if (!topDepthEntries || topDepthEntries.length === 0) { topDepthBlock.style.display = 'none'; return; }
    topDepthBlock.style.display = '';
    const filter = (topDepthFilter && topDepthFilter.value || '').trim().toLowerCase();
    let list = topDepthEntries;
    if (filter) {
      list = topDepthEntries.filter(e =>
        ((e.file || '').toLowerCase().indexOf(filter) !== -1) ||
        (e.name.toLowerCase().indexOf(filter) !== -1));
    }
    const shown = filter ? list : list.slice(0, TOP_VIEW_LIMIT);
    topDepthCount.textContent = filter
      ? (list.length + ' match' + (list.length === 1 ? '' : 'es'))
      : topDepthEntries.length;
    if (shown.length === 0) {
      topDepthDiv.innerHTML = '<div class="empty">No function matches that path or name.</div>';
      return;
    }
    topDepthDiv.innerHTML = shown.map(e => {
      const tags = [];
      if (e.recursive) tags.push('<span class="top-flag" title="' +
        (e.recursiveViaFp ? 'possible recursion (via fn-ptr)' : 'certain recursion') +
        '">' + (e.recursiveViaFp ? '↻?' : '↻') + '</span>');
      if (e.pinnedRoot) tags.push('<span class="top-flag">📌</span>');
      else if (e.autoRoot) tags.push('<span class="top-flag">⚓</span>');
      let pathRow = '';
      if (filter && e.file) {
        pathRow = '<div class="top-path" title="' + escape(e.file) + '">' +
          highlight(e.file, filter) + '</div>';
      }
      const depthTxt = e.depth + (e.bounded ? '+' : '');
      return '<div class="top-row" data-top="' + escape(e.name) + '">' +
        '<div style="min-width:0;flex:1">' +
          '<div class="top-name">' + escape(e.name) + ' ' + tags.join('') + '</div>' +
          pathRow +
        '</div>' +
        '<div class="stat-value" title="deepest downward call chain (levels)">d:' + depthTxt + '</div>' +
        '</div>';
    }).join('');
    for (const el of topDepthDiv.querySelectorAll('[data-top]')) {
      el.addEventListener('click', () => {
        q.value = el.getAttribute('data-top');
        vscode.postMessage({ type: 'query', name: q.value });
      });
    }
    wireCollapsibles(topDepthBlock);
  }

  // Top-by-frame list — mirrors renderTop but ranks by each function's OWN stack
  // frame (the -fstack-usage size), shown in bytes on the right. The Overview tab
  // badge is owned by renderTop, so this does not touch it.
  function renderTopFrame(entries) {
    if (entries) topFrameEntries = entries;
    if (!topFrameEntries || topFrameEntries.length === 0) { topFrameBlock.style.display = 'none'; return; }
    topFrameBlock.style.display = '';
    const filter = (topFrameFilter && topFrameFilter.value || '').trim().toLowerCase();
    let list = topFrameEntries;
    if (filter) {
      list = topFrameEntries.filter(e =>
        ((e.file || '').toLowerCase().indexOf(filter) !== -1) ||
        (e.name.toLowerCase().indexOf(filter) !== -1));
    }
    const shown = filter ? list : list.slice(0, TOP_VIEW_LIMIT);
    topFrameCount.textContent = filter
      ? (list.length + ' match' + (list.length === 1 ? '' : 'es'))
      : topFrameEntries.length;
    if (shown.length === 0) {
      topFrameDiv.innerHTML = '<div class="empty">No function matches that path or name.</div>';
      return;
    }
    topFrameDiv.innerHTML = shown.map(e => {
      const sev = sevClass(e.frame);
      const tags = [];
      if (e.recursive) tags.push('<span class="top-flag" title="' +
        (e.recursiveViaFp ? 'possible recursion (via fn-ptr)' : 'certain recursion') +
        '">' + (e.recursiveViaFp ? '↻?' : '↻') + '</span>');
      if (e.pinnedRoot) tags.push('<span class="top-flag">📌</span>');
      else if (e.autoRoot) tags.push('<span class="top-flag">⚓</span>');
      let pathRow = '';
      if (filter && e.file) {
        pathRow = '<div class="top-path" title="' + escape(e.file) + '">' +
          highlight(e.file, filter) + '</div>';
      }
      const qtitle = e.qualifier ? ' (' + escape(e.qualifier) + ')' : '';
      return '<div class="top-row" data-top="' + escape(e.name) + '">' +
        '<div style="min-width:0;flex:1">' +
          '<div class="top-name">' + escape(e.name) + ' ' + tags.join('') + '</div>' +
          pathRow +
        '</div>' +
        '<div class="stat-value ' + sev + '" title="own stack frame' + qtitle + '">' + fmtBytes(e.frame) + '</div>' +
        '</div>';
    }).join('');
    for (const el of topFrameDiv.querySelectorAll('[data-top]')) {
      el.addEventListener('click', () => {
        q.value = el.getAttribute('data-top');
        vscode.postMessage({ type: 'query', name: q.value });
      });
    }
    wireCollapsibles(topFrameBlock);
  }

  // Highlight (case-insensitive) the matched substring inside an escaped path.
  function highlight(text, needle) {
    const lc = text.toLowerCase();
    const i = lc.indexOf(needle);
    if (i === -1) return escape(text);
    return escape(text.slice(0, i)) + '<b>' + escape(text.slice(i, i + needle.length)) +
           '</b>' + escape(text.slice(i + needle.length));
  }

  function render(r, fromAutoRefresh) {
    if (!r) {
      result.innerHTML = '<div class="empty">No function found by that name. Tip: libclang must have parsed it (and it must not be a ghost-only entry).</div>';
      currentOpenFn = '';
      saveOpenFn('');
      return;
    }
    currentOpenFn = r.name;
    lastDetail = r;
    saveOpenFn(r.name);
    // Only switch to the Function tab for an explicit lookup. On a background
    // re-query (analysis refresh / restore) while the user is on Overview, keep
    // them on Overview — just update the detail underneath.
    const onOverview = overviewTab && overviewTab.style.display !== 'none';
    if (!(fromAutoRefresh && onOverview)) switchTab('function');
    // A result is now showing, so close the autocomplete dropdown and clear its
    // match state — otherwise it can stay open over the detail view (e.g. after
    // clicking a function in an Overview list, which sets q.value).
    if (suggestions) suggestions.style.display = 'none';
    currentMatches = [];
    activeIndex = -1;
    pushRecent(r.name);
    thresholds = { warn: r.thresholdWarn, critical: r.thresholdCritical };
    // The top-of-card Peak is the function's OWN downward worst case (its
    // frame + heaviest callee chain below it), independent of any entry point.
    // The per-root table shows the entry-inclusive peak (root→…→fn→…→deepest).
    const dispPeak = r.cumulativeStack;
    const dispBounded = r.cumulativeBounded;
    const sev = sevClass(dispPeak);
    const peak = dispPeak !== undefined
      ? fmtBytes(dispPeak) + (dispBounded ? '+' : '')
      : '?';
    const frame = r.stackBytes !== undefined
      ? fmtBytes(r.stackBytes)
      : '?';
    const frameSuffix = r.stackQualifier ? ' <span class="hint">(' + escape(r.stackQualifier) + ')</span>' : '';

    let html = '<div class="card">';
    html += '<div class="fn-row">';
    html += '<span class="fn-name">' + escape(r.name) + '</span>';
    if (r.recursive) {
      if (r.recursiveViaFp) {
        html += '<span class="flag flag-rec-fp" title="Cycle relies only on function-pointer edges, which are over-approximated — this recursion is possible, not certain.">recursive? ↻ (via fn-ptr)</span>';
      } else {
        html += '<span class="flag flag-rec" title="A direct call participates in the cycle — this recursion is certain.">recursive ↻</span>';
      }
    }
    if (r.pinnedRoot) html += '<span class="flag flag-pin">📌 pinned root</span>';
    else if (r.autoRoot) html += '<span class="flag flag-auto">⚓ auto root</span>';
    if (r.fpVerified) html += '<span class="flag flag-verified" title="Indirect (function-pointer) call sites here were manually verified via fp-overrides; fp targets are exact, not over-approximated.">fp verified ✓</span>';
    html += '</div>';

    // Peak is the function's own downward worst case (frame + heaviest callee
    // chain), independent of any entry point — so the top card shows just the
    // function's Frame and Peak. Depth is a per-root notion (how deep this
    // function sits from a given root), so it lives in the per-root table and
    // the caller/callee chains below, not here.
    html += '<div class="stats">';
    html += '<div class="stat"><div class="stat-label">Frame</div><div class="stat-value ' + (r.stackBytes === undefined ? 'unk' : '') + '">' + frame + frameSuffix + '</div></div>';
    html += '<div class="stat"><div class="stat-label">Peak</div><div class="stat-value ' + sev + '">' + peak + '</div></div>';
    html += '</div>';

    // Function-pointer call sites in THIS function: show whether each was
    // manually bound (verified, exact) or is still over-approximated.
    if (Array.isArray(r.fpSites) && r.fpSites.length > 0) {
      html += '<div class="fp-sites">';
      html += '<div class="section-title">Function-pointer calls</div>';
      for (const s of r.fpSites) {
        const bound = s.overridden === true;
        const hasCand = s.candidates && s.candidates.length;
        const cls = bound ? 'bound' : 'approx';
        const mark = bound ? '✓' : '⚠';
        // Explicit state word so it's unmistakable whether binding was done.
        const label = bound
          ? '<span class="fp-state">bound</span>'
          : (hasCand
              ? '<span class="fp-state">estimated · not bound</span>'
              : '<span class="fp-state">unresolved · not bound</span>');
        const via = s.via ? '<span class="fp-via">' + escape(s.via) + '</span>' : '<span class="fp-via">(fp)</span>';
        // The line number jumps to the fp call site in source (this function's
        // file + the call-site line). Lets you reach the indirect call fast.
        const loc = s.line
          ? ' <span class="fp-loc fp-loc-link" data-goto-file="' + escape(r.file) +
            '" data-goto-line="' + s.line + '" title="Jump to this call site">line ' + s.line + '</span>'
          : '';
        // Each inferred target is a clickable function link (open in panel,
        // hover info, right-click menu) so you can follow the fp edge fast.
        const tgts = hasCand
          ? ' → <span class="fp-tgts">' +
            s.candidates.map(t => '<span class="fn-clickable" data-fn="' + escape(t) + '">' + escape(t) + '</span>').join(', ') +
            '</span>'
          : ' <span class="fp-tgts">(no targets inferred)</span>';
        const title = bound
          ? 'Manually bound via fp-overrides — targets are exact.'
          : (hasCand
              ? 'Estimated, NOT bound — targets inferred automatically (worst-case over-approximation). Add an fp-override to verify.'
              : 'Unresolved, NOT bound — no targets inferred; contributes nothing to the stack estimate (possible under-approximation). Add an fp-override.');
        html += '<div class="fp-site ' + cls + '" title="' + title + '">' +
                '<span class="fp-mark">' + mark + '</span>' + via + ' ' + label + loc + tgts + '</div>';
      }
      html += '</div>';
    }

    html += '<div class="file-row">';
    const fileTail = r.file.split(/[\\\/]/).slice(-2).join('/');
    html += '<span class="path-tail" title="' + escape(r.file) + '">' + escape(fileTail) + ' · L' + (r.nameLine + 1) + '</span>';
    html += '<button class="open-btn" data-graph="1">graph ⊹</button>';
    html += '<button class="open-btn" data-open="1">open ↗</button>';
    html += '</div>';
    html += '</div>';

    // Per-root breakdown. Shown whenever the function is reached from at least
    // one entry point, so you can always see WHICH root(s) reach it and at what
    // depth — even when there's a single root (previously hidden, which made it
    // look like the function had no per-root data).
    // Sortable by root name / depth / peak; see renderPerRootTable.
    if (r.perRoot && r.perRoot.length >= 1) {
      currentPerRoot = r.perRoot.slice();
      html += '<div id="per-root-host"></div>';
    } else {
      currentPerRoot = null;
    }

    // Incremental reveal: render every row but cap how many are visible.
    // "show 10 more" reveals the next chunk; "show all" reveals everything;
    // once everything is visible both buttons disappear. State lives in the
    // wrapper's data-visible attribute so no extension round-trip is needed.
    const REVEAL_STEP = 10;
    function renderRevealSection(label, htmlRows, totalCount, opts) {
      opts = opts || {};
      const initial = Math.min(pathsLimit, totalCount);
      const hasMore = totalCount > pathsLimit;
      const badge = hasMore ? initial + '+' : String(totalCount);
      const note = ((hasMore || opts.alwaysNote) && opts.note)
        ? '<span class="hint" style="margin-left:6px">' + opts.note + '</span>' : '';
      const capped = (opts.capAt && totalCount >= opts.capAt) ? ' <span class="hint">(capped at ' + opts.capAt + ')</span>' : '';
      // Collapsible header (accordion). data-collapse key lets open/closed state
      // persist across re-renders; the body + reveal-controls collapse together.
      const ckey = opts.collapseKey || ('sec-' + label.replace(/[^a-z0-9]+/gi, '-').toLowerCase());
      let h = '<div class="section-label collapsible" data-collapse="' + ckey + '">' +
              '<span class="twist">▶</span>' + label +
              ' <span class="count">' + badge + '</span>' + (opts.sortControls || '') + note + capped + '</div>';
      // Wrap all rows. Each row gets the rowClass; visibility is controlled
      // by the reveal wiring keyed off the wrapper's data-visible count.
      h += '<div class="reveal-wrap" data-collapse-body="' + ckey + '" data-visible="' + initial + '" data-total="' + totalCount + '">';
      h += htmlRows;
      h += '</div>';
      if (hasMore) {
        h += '<div class="reveal-controls">';
        h += '<button class="reveal-btn" data-reveal="step">show ' +
             Math.min(REVEAL_STEP, totalCount - initial) + ' more</button>';
        h += '<button class="reveal-btn" data-reveal="all">show all (' + totalCount + ')</button>';
        h += '<button class="reveal-btn" data-reveal="less" style="display:none">show less</button>';
        h += '</div>';
      }
      return h;
    }

    function renderSection(label, paths, grandTotal, cap) {
      const total = paths.length;
      const isCallers = label === 'Callers';
      const isCallsInto = label === 'Calls into';
      // Sort client-side by the section's chosen key so the user can flip between
      // "deepest stack" and "longest chain (hops)" without a re-query.
      const sortBy = isCallers ? callersSort : isCallsInto ? callsIntoSort : 'stack';
      const ordered = paths.slice();
      if (sortBy === 'hops') {
        ordered.sort((a, b) => (b.nodes.length - a.nodes.length) || ((b.totalStack || 0) - (a.totalStack || 0)));
      } else {
        ordered.sort((a, b) => ((b.totalStack || 0) - (a.totalStack || 0)) || (b.nodes.length - a.nodes.length));
      }
      let rows = renderPaths(ordered);
      // If the server capped the path list, say so prominently so the user
      // knows the view is incomplete (not just "these are all of them").
      if (typeof grandTotal === 'number' && grandTotal > total) {
        rows = '<div class="trunc-note">⚠ showing ' + total + ' of ' +
          grandTotal + ' — list capped at ' + (cap || total) +
          '; open the call graph to see all</div>' + rows;
      }
      // The meaning note (what each chain's stack sums) lives in the body so the
      // header stays compact next to the sort toggle. Caller chains sum only the
      // upward path; callee chains sum only the downward path.
      const meaning = isCallers ? 'caller-path stack (upward only)'
                    : isCallsInto ? 'callee-path stack (downward only)'
                    : '';
      if (meaning) rows = '<div class="hint" style="margin:2px 0 6px">' + meaning + '</div>' + rows;
      // Sort toggle (Callers / Calls into only): stack vs hops.
      let sortControls = '';
      if (isCallers || isCallsInto) {
        const sec = isCallers ? 'callers' : 'callsInto';
        const mk = (by, lbl) => '<button class="sort-btn' + (sortBy === by ? ' active' : '') +
          '" data-sortsec="' + sec + '" data-sortby="' + by +
          '" title="Sort by ' + lbl + '">' + lbl + '</button>';
        sortControls = '<span class="sort-ctl" title="Sort order">' + mk('stack', 'stack') + mk('hops', 'hops') + '</span>';
      }
      return renderRevealSection(label, rows, total, {
        sortControls: sortControls,
        capAt: 50
      });
    }

    if (r.cycles && r.cycles.length > 0) {
      const certain = !r.recursiveViaFp;
      const more = r.cyclesTruncated
        ? (r.cyclesLimitHit === 'depth'
            ? ' Showing the shortest loop; longer cycles exist beyond the path-length limit.'
            : r.cyclesLimitHit === 'budget'
              ? ' Showing a representative subset; this function is in a large, densely connected cycle group.'
              : ' Showing the first ' + r.cycles.length + ' cycles; more exist.')
        : '';
      let rows = '<div class="rec-path-note">' +
        (certain
          ? 'This function is part of a recursion cycle (a direct call loops back to it).'
          : 'This function appears recursive only through a function-pointer table (over-approximated — the loop may not be real).') +
        more +
        '</div>';
      rows += renderCyclePaths(r.cycles);
      html += renderRevealSection(
        'Recursion paths ' + (certain ? '↻' : '↻?'),
        rows, r.cycles.length, { note: 'loops back to ' + escape(r.name), capAt: 50 });
    } else if (r.recursive) {
      // No concrete loop even after the shortest-cycle fallback — so there is no
      // real cycle in the recorded edges. This only happens when recursion was
      // inferred solely through a function-pointer over-approximation.
      const certain = !r.recursiveViaFp;
      const why = !certain
        ? 'This function is flagged recursive only through a function-pointer table (over-approximated). No concrete call loop exists in the recorded edges, so the cycle may not occur at runtime — bind the fp call site with an fp-override to confirm.'
        : 'This function is in a recursion cycle, but the looping edge is indirect, so no explicit call path could be reconstructed. Its peak is treated as a bounded lower estimate.';
      html += '<div class="section-label">Recursion ' + (certain ? '↻' : '↻?') + '</div>';
      html += '<div class="rec-path-note">' + why + '</div>';
    }

    if (r.incoming && r.incoming.length > 0) {
      html += renderSection('Callers', r.incoming, r.incomingTotal, r.pathCap);
    }
    if (r.outgoing && r.outgoing.length > 0) {
      html += renderSection('Calls into', r.outgoing, r.outgoingTotal, r.pathCap);
    }
    if ((r.incoming || []).length === 0 && (r.outgoing || []).length === 0) {
      html += '<div class="empty">No callers or callees in workspace — leaf or unreachable function.</div>';
    }

    result.innerHTML = html;
    // Fill the per-root table host (if this function has multiple roots).
    renderPerRootTable();
    wireRevealControls(result);
    wireCollapsibles(result);
    // Sort toggles on the Callers / Calls into headers (stack vs hops). Clicking
    // one flips the sort and re-renders the detail; stopPropagation keeps the
    // click from also collapsing the section.
    for (const btn of result.querySelectorAll('[data-sortsec]')) {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const sec = btn.getAttribute('data-sortsec');
        const by = btn.getAttribute('data-sortby');
        if (sec === 'callers') callersSort = by;
        else if (sec === 'callsInto') callsIntoSort = by;
        if (lastDetail) render(lastDetail);
      });
    }
    const openBtn = result.querySelector('[data-open]');
    if (openBtn) {
      openBtn.addEventListener('click', () => {
        vscode.postMessage({ type: 'open', file: r.file, line: r.nameLine, col: r.nameCol });
      });
    }
    const graphBtn = result.querySelector('[data-graph]');
    if (graphBtn) {
      graphBtn.addEventListener('click', () => {
        vscode.postMessage({ type: 'graph', name: r.name });
      });
    }
    // Make every function name in the rendered chains clickable — sends
    // the user to the function's source location via the extension host.
    for (const el of result.querySelectorAll('[data-fn]')) {
      el.addEventListener('click', () => {
        const name = el.getAttribute('data-fn');
        if (name) vscode.postMessage({ type: 'goto', name });
      });
      el.addEventListener('contextmenu', (ev) => {
        ev.preventDefault();
        const name = el.getAttribute('data-fn');
        if (name) showCtxMenu(ev.clientX, ev.clientY, name);
      });
      // Hover: show name + Frame/Peak as a native tooltip. Use the cache if we
      // have it; otherwise ask the host once and fill it in when it replies.
      el.addEventListener('mouseenter', () => {
        const name = el.getAttribute('data-fn');
        if (!name) return;
        if (fnInfoCache[name]) { el.setAttribute('title', fnInfoCache[name]); }
        else { el.setAttribute('title', name + ' — (loading…)'); vscode.postMessage({ type: 'requestFnInfo', name }); }
      });
    }
    // (Per-root root-name clicks are wired inside renderPerRootTable, since
    // that table is re-rendered on sort and needs fresh handlers each time.)
    // fp call-site line numbers: jump straight to the indirect call in source.
    for (const el of result.querySelectorAll('.fp-loc-link')) {
      el.addEventListener('click', () => {
        const file = el.getAttribute('data-goto-file');
        const line = parseInt(el.getAttribute('data-goto-line') || '0', 10);
        if (file && line > 0) {
          vscode.postMessage({ type: 'open', file: file, line: line - 1, col: 0 });
        }
      });
    }
  }

  // Render the per-root table into #per-root-host, honoring perRootSort.
  // Re-callable so column-header clicks can re-sort in place. Pseudo-roots
  // ((auto)/(unreached)) always sort to the bottom regardless of direction,
  // since they aren't comparable entry points.
  function renderPerRootTable() {
    const host = document.getElementById('per-root-host');
    if (!host || !currentPerRoot) return;

    const rows0 = currentPerRoot.slice();
    const pf = perRootFilter.trim().toLowerCase();
    const rows = pf
      ? rows0.filter(e => ((e.rootFile || '').toLowerCase().indexOf(pf) !== -1) ||
                          (String(e.rootName).toLowerCase().indexOf(pf) !== -1))
      : rows0;
    const { key, dir } = perRootSort;
    const isPseudo = (e) => e.rootName === '(auto)' || e.rootName === '(unreached)';
    rows.sort((a, b) => {
      const ap = isPseudo(a), bp = isPseudo(b);
      if (ap !== bp) return ap ? 1 : -1;  // pseudo-roots always last
      let av, bv;
      if (key === 'root') { av = a.rootName; bv = b.rootName;
        return dir * String(av).localeCompare(String(bv)); }
      if (key === 'depth') { av = a.depth || 0; bv = b.depth || 0; }
      else { av = a.cumulativeStack === undefined ? -1 : a.cumulativeStack;
             bv = b.cumulativeStack === undefined ? -1 : b.cumulativeStack; }
      if (av !== bv) return dir * (av - bv);
      // tie-break by root name asc for stable order
      return String(a.rootName).localeCompare(String(b.rootName));
    });

    const total = rows.length;
    const initial = Math.min(pathsLimit, total);
    const hasMore = total > pathsLimit;
    const badge = pf ? (total + ' match' + (total === 1 ? '' : 'es'))
                     : (hasMore ? initial + '+' : String(total));

    // Sort indicator arrow for a column.
    const arrow = (k) => perRootSort.key === k
      ? (perRootSort.dir < 0 ? ' ▼' : ' ▲') : '';

    let html = '<div class="section-label">Per-root analysis <span class="count">' + badge + '</span>'
      + '<span class="hint" style="margin-left:6px">peak = entry path + downward subtree</span></div>';
    html += '<input id="per-root-filter" class="top-filter" type="text" autocomplete="off" spellcheck="false"' +
            ' placeholder="Filter roots by path or name" value="' + escape(perRootFilter) + '" />';
    html += '<div class="card" style="padding:0">';
    html += '<table class="per-root-tbl">';
    html += '<colgroup><col class="c-root"><col class="c-depth"><col class="c-peak"><col class="c-graph"></colgroup>';
    html += '<thead><tr>';
    html += '<th class="sortable" data-sort="root">From root' + arrow('root') + '</th>';
    html += '<th class="sortable" data-sort="depth">Depth' + arrow('depth') + '</th>';
    html += '<th class="sortable" data-sort="peak" title="Total stack from this root down through the function to its deepest leaf (entry path + downward peak).">Peak from root' + arrow('peak') + '</th>';
    html += '<th title="Show this root→function path in the call graph"></th>';
    html += '</tr></thead>';
    if (total === 0) {
      html += '</table><div class="empty" style="padding:8px">No root matches that path or name.</div></div>';
      host.innerHTML = html;
      const fi = document.getElementById('per-root-filter');
      if (fi) wirePerRootFilter(fi);
      return;
    }
    html += '<tbody class="reveal-wrap" data-visible="' + initial + '" data-total="' + total + '">';
    for (const e of rows) {
      const sev2 = sevClass(e.cumulativeStack);
      const peak2 = e.cumulativeStack === undefined ? '—'
        : fmtBytes(e.cumulativeStack) + (e.cumulativeBounded ? '+' : '');
      const isSpecial = isPseudo(e);
      const marker = e.rootIsPinned ? '📌 ' : (e.isAuto ? '⚓ ' : '');
      const rootMain = isSpecial
        ? '<em>' + escape(e.rootName) + '</em>'
        : marker +
          '<span class="fn-clickable root-link" data-query="' + escape(e.rootName) + '">' +
          escape(e.rootName) + '</span>';
      // When filtering, show the root's path (highlighted) under its name.
      const rootCell = rootMain +
        ((pf && !isSpecial && e.rootFile)
          ? '<div class="top-path" title="' + escape(e.rootFile) + '">' + highlight(e.rootFile, pf) + '</div>'
          : '');
      // Per-root → graph shortcut (not for pseudo-roots, which aren't real fns).
      const graphCell = isSpecial ? ''
        : '<button class="graph-jump" title="View this root→function path in the call graph"' +
          ' data-graph-root="' + escape(e.rootName) + '" data-graph-depth="' + (e.depth || 0) + '">⊹</button>';
      html += '<tr><td>' + rootCell + '</td>';
      html += '<td><code>' + e.depth + '</code></td>';
      html += '<td><span class="stat-value ' + sev2 + '">' + peak2 + '</span></td>';
      html += '<td style="text-align:right">' + graphCell + '</td></tr>';
    }
    html += '</tbody></table></div>';
    if (hasMore) {
      html += '<div class="reveal-controls">';
      html += '<button class="reveal-btn" data-reveal="step">show ' +
              Math.min(10, total - initial) + ' more</button>';
      html += '<button class="reveal-btn" data-reveal="all">show all (' + total + ')</button>';
      html += '<button class="reveal-btn" data-reveal="less" style="display:none">show less</button>';
      html += '</div>';
    }
    host.innerHTML = html;

    // Header click → set/toggle sort and re-render in place.
    for (const th of host.querySelectorAll('th.sortable')) {
      th.addEventListener('click', () => {
        const k = th.getAttribute('data-sort');
        if (perRootSort.key === k) {
          perRootSort.dir = -perRootSort.dir;       // toggle direction
        } else {
          perRootSort.key = k;
          // Sensible defaults: text asc, numbers desc.
          perRootSort.dir = (k === 'root') ? 1 : -1;
        }
        renderPerRootTable();
      });
    }
    // Re-bind reveal controls and root-link queries for the fresh DOM.
    wireRevealControls(host);
    for (const el of host.querySelectorAll('[data-query]')) {
      el.addEventListener('click', () => {
        const name = el.getAttribute('data-query');
        if (name) {
          q.value = name;
          suggestions.style.display = 'none';
          pushRecent(name);
          vscode.postMessage({ type: 'query', name });
        }
      });
    }
    // Per-root → call-graph shortcut: open the graph focused on this root,
    // expanded down to the current function.
    for (const btn of host.querySelectorAll('.graph-jump')) {
      btn.addEventListener('click', (ev) => {
        ev.stopPropagation();
        const root = btn.getAttribute('data-graph-root');
        const depth = parseInt(btn.getAttribute('data-graph-depth') || '0', 10);
        if (root && currentOpenFn) {
          vscode.postMessage({ type: 'openGraphFromRoot', root, target: currentOpenFn, depth });
        }
      });
    }
    const fi = document.getElementById('per-root-filter');
    if (fi) wirePerRootFilter(fi);
  }

  // Wire the per-root filter input. The table is re-rendered on each keystroke,
  // so we re-grab focus and restore the caret to keep typing smooth.
  function wirePerRootFilter(input) {
    input.addEventListener('input', () => {
      perRootFilter = input.value;
      const caret = input.selectionStart;
      renderPerRootTable();
      const again = document.getElementById('per-root-filter');
      if (again) { again.focus(); try { again.setSelectionRange(caret, caret); } catch (_) {} }
    });
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        perRootFilter = '';
        renderPerRootTable();
        const again = document.getElementById('per-root-filter');
        if (again) again.focus();
      }
    });
  }

  // Remembers which collapsible sections the user closed, so re-renders (e.g.
  // after a new query) keep the same open/closed state. Keyed by data-collapse.
  // Default (first run, nothing persisted): the overview lists start COLLAPSED
  // so the panel opens compact; the user expands what they want.
  const collapsedSections = (function () {
    try {
      const saved = (vscode.getState() || {}).collapsed;
      if (saved && Object.keys(saved).length) return saved;
    } catch (_) {}
    return { top: true, "top-depth": true, "top-frame": true, rec: true, unbound: true };
  })();
  // Wire any .section-label.collapsible inside root. The body is the element
  // marked data-collapse-body / id="<key>-body", else the next sibling.
  function wireCollapsibles(root) {
    for (const head of root.querySelectorAll('.section-label.collapsible')) {
      if (head.getAttribute('data-collapse-wired') === '1') continue;
      head.setAttribute('data-collapse-wired', '1');
      const key = head.getAttribute('data-collapse') || '';
      let body = null;
      // Prefer an element explicitly bound by key (static id or data attribute).
      if (key) body = document.getElementById(key + '-body') ||
                       root.querySelector('[data-collapse-body="' + key + '"]');
      if (!body) {
        const n = head.nextElementSibling;
        if (n && (n.classList.contains('collapse-body') || n.classList.contains('reveal-wrap'))) body = n;
      }
      if (!body) continue;
      // For caller/callee sections the body is followed by reveal-controls;
      // group them so collapsing hides both. Mark the controls too.
      const extra = (body.classList.contains('reveal-wrap') && body.nextElementSibling &&
                     body.nextElementSibling.classList.contains('reveal-controls'))
                    ? body.nextElementSibling : null;
      const setState = (collapsed) => {
        head.classList.toggle('collapsed', collapsed);
        body.classList.toggle('hidden', collapsed);
        if (extra) extra.classList.toggle('hidden', collapsed);
        if (key) {
          collapsedSections[key] = collapsed;
          try { const s = vscode.getState() || {}; s.collapsed = collapsedSections; vscode.setState(s); } catch (_) {}
        }
      };
      // Restore remembered state (default: open).
      setState(key ? collapsedSections[key] === true : false);
      head.addEventListener('click', () => {
        const nowCollapsed = !head.classList.contains('collapsed');
        setState(nowCollapsed);
      });
    }
  }


  // The wrap may be the immediate previous sibling (path sections) or nested
  // inside a preceding container like a .card (the per-root table's tbody).
  function wireRevealControls(root) {
    for (const controls of root.querySelectorAll('.reveal-controls')) {
      let wrap = controls.previousElementSibling;
      if (wrap && !wrap.classList.contains('reveal-wrap')) {
        // Look for a .reveal-wrap nested inside the previous sibling.
        wrap = wrap.querySelector ? wrap.querySelector('.reveal-wrap') : null;
      }
      if (!wrap || !wrap.classList.contains('reveal-wrap')) continue;
      const total = parseInt(wrap.getAttribute('data-total') || '0', 10);
      const stepBtn = controls.querySelector('[data-reveal="step"]');
      const allBtn = controls.querySelector('[data-reveal="all"]');
      const lessBtn = controls.querySelector('[data-reveal="less"]');
      const STEP = 10;

      function apply(visible) {
        wrap.setAttribute('data-visible', String(visible));
        const rows = wrap.children;
        for (let i = 0; i < rows.length; i++) {
          rows[i].style.display = i < visible ? '' : 'none';
        }
        const atEnd = visible >= total;
        const atStart = visible <= Math.min(5, total);
        if (stepBtn) {
          stepBtn.style.display = atEnd ? 'none' : '';
          if (!atEnd) stepBtn.textContent = 'show ' + Math.min(STEP, total - visible) + ' more';
        }
        if (allBtn) allBtn.style.display = atEnd ? 'none' : '';
        if (lessBtn) lessBtn.style.display = atStart ? 'none' : '';
      }

      if (stepBtn) stepBtn.addEventListener('click', () => {
        const cur = parseInt(wrap.getAttribute('data-visible') || '0', 10);
        apply(Math.min(total, cur + STEP));
      });
      if (allBtn) allBtn.addEventListener('click', () => apply(total));
      if (lessBtn) lessBtn.addEventListener('click', () => apply(Math.min(5, total)));
      const initial = parseInt(wrap.getAttribute('data-visible') || '0', 10);
      apply(initial);
    }
  }

</script>
</body>
</html>`;
    }
}
