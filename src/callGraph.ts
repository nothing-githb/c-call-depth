// src/callGraph.ts

/** Per-function data the call-graph algorithm needs.
 *  Populated from LSP (call hierarchy) and stack-usage (.su files). */
export interface FunctionRecord {
  name: string;
  file: string;
  /** 0-based line of the function-name identifier */
  nameLine: number;
  /** 0-based column of the function-name identifier */
  nameCol: number;
  /** names of called functions */
  callees: string[];
  /** stack frame size in bytes from -fstack-usage; undefined if not analyzed */
  stackBytes?: number;
  /** stack-usage qualifier from .su file: e.g. "static", "dynamic", "bounded" */
  stackQualifier?: string;
  /** true when the record was synthesized purely from a .su entry (LSP
   *  hadn't reported this function). Ghost records contribute to the call
   *  graph for stack-accounting but are not surfaced as decorations or
   *  in the side-panel autocomplete. */
  ghost?: boolean;
  /** Subset of `callees` that are only reachable through a function-pointer
   *  table (over-approximated by the libclang analyzer). The UI flags these
   *  as indirect, and recursion that relies solely on them is "possible"
   *  rather than "certain". */
  indirectCallees?: string[];
}

export interface DepthInfo {
  /** longest chain length from any root to this function, 1-based (root = 1)
   *  Legacy aggregate: max over perRoot (or 1 if perRoot is empty). */
  depth: number;
  /** longest call chain length going DOWNWARD from this function (fn itself
   *  = 1) — i.e. the deepest point this function reaches, independent of any
   *  caller above it. */
  downDepth?: number;
  /** true if the downward depth chain was capped by a cycle/limit. */
  downDepthBounded?: boolean;
  /** true if this function is itself a pinned root (an entry point). */
  isPinnedRoot?: boolean;
  /** true if this function is itself an auto root (caller-less, non-pinned). */
  isAutoRoot?: boolean;
  /** true if this function participates in a recursive cycle */
  recursive: boolean;
  /** true if the recursion relies ONLY on function-pointer edges (which are
   *  over-approximated) — i.e. the cycle is "possible" but not certain. When
   *  recursive is true and this is false, recursion is via a direct call. */
  recursiveViaFp?: boolean;
  /** true when this function's indirect call site(s) were manually verified
   *  via fp-overrides, so its fp edges are exact (not over-approximated). */
  fpVerified?: boolean;
  /** Function-pointer call sites in this function: line, auto-resolved
   *  candidate targets, and whether an override already covers them. Used to
   *  generate an fp-overrides.json template. */
  fpSites?: { line: number; via?: string; candidates: string[]; overridden: boolean; viaParam?: number }[];
  /** worst-case cumulative stack across all roots that reach this fn. */
  cumulativeStack?: number;
  /** true if any reach hit the cycle/limit guard */
  cumulativeBounded?: boolean;
  /** Per-root breakdown. Each entry corresponds to one root from which this
   *  function is reachable. For a function that is itself a pinned root,
   *  one entry has rootName === function name and depth === 1.
   *  - If pinnedRoots is empty (legacy mode), there is a single synthetic
   *    "(auto)" entry corresponding to the traditional any-root analysis.
   *  - Otherwise, one entry per pinned root that reaches this function. */
  perRoot: PerRootAnalysis[];
}

/** One entry-point's view of a function's call depth and worst-case stack. */
export interface PerRootAnalysis {
  /** Name of the root the analysis starts from. The string "(auto)" is used
   *  in legacy mode when no pinned roots are configured; "(unreached)" marks
   *  a function no root reaches. Otherwise it's a real function name. */
  rootName: string;
  /** Depth from root to this function (root itself is depth 1). */
  depth: number;
  /** Worst-case cumulative stack of a full chain root → … → fn → … → leaf
   *  that passes through this function. PATH-SENSITIVE: it includes the
   *  frames accumulated from the root down to fn, so it is consistent with
   *  `depth` (a deeper path yields a larger peak). */
  cumulativeStack?: number;
  /** True if this per-root traversal hit recursion or the depth cap. */
  cumulativeBounded?: boolean;
  /** True when this root is an "auto" root: a caller-less function that is
   *  not a pinned root. Shown with the ⚓ marker. In legacy mode the single
   *  "(auto)" entry is also flagged. */
  isAuto?: boolean;
}

export interface AnalysisResult {
  functions: Map<string, FunctionRecord>;
  /** name -> caller's depth info */
  depth: Map<string, DepthInfo>;
}

/** A single path through the call graph, listed as function names. */
export interface CallPath {
  /** function names in call order: paths-from = self → callee → ...,
   *  paths-to   = root caller → ... → self */
  nodes: string[];
  /** sum of stackBytes along the path; missing frames contribute 0 */
  totalStack: number;
  /** true if traversal was cut off by a cycle (path may be incomplete) */
  truncatedByCycle: boolean;
}

// ── Graph neighborhood extraction (for the interactive graph view) ─────

export interface GraphNode {
  name: string;
  file: string;
  nameLine: number;
  stackBytes?: number;
  /** worst-case downward cumulative stack (entry-independent aggregate) */
  peak?: number;
  recursive: boolean;
  /** true when this function's fp call sites were manually bound (verified). */
  fpVerified?: boolean;
  /** true when this function has fp call site(s) that are NOT bound (estimated). */
  hasUnboundFp?: boolean;
  /** true if this node is an entry point (pinned root or caller-less). */
  isRoot?: boolean;
  /** "pinned" | "auto" when isRoot; undefined otherwise. */
  rootKind?: "pinned" | "auto";
  /** hop distance from the focus node (0 = focus, negative = caller side,
   *  positive = callee side). Used for layout layering. */
  layer: number;
  /** true if this node has callees/callers we didn't expand (depth limit) */
  truncatedCallees?: boolean;
  truncatedCallers?: boolean;
  isFocus: boolean;
}

export interface GraphEdge {
  from: string;
  to: string;
  /** true when this edge is an indirect (function-pointer) call */
  indirect?: boolean;
  /** true when this indirect edge was MANUALLY bound via fp-overrides — i.e.
   *  the target is verified/exact, not an over-approximation. Shown specially. */
  fpVerified?: boolean;
  /** true when this edge participates in a cycle (recursion) */
  recursive?: boolean;
  /** true when this edge does NOT lie on a caller→focus or focus→callee flow
   *  (e.g. a caller-side node also calling a callee-side node). These "cross"
   *  edges are dimmed so the focus hierarchy reads clearly. */
  offFocus?: boolean;
}

export interface GraphData {
  focus: string;
  nodes: GraphNode[];
  edges: GraphEdge[];
  /** true when the node budget was hit, so the neighborhood is partial. */
  truncatedByBudget?: boolean;
}

/** Build a bounded neighborhood graph around `focus`: up to `upHops` levels
 *  of callers and `downHops` levels of callees. Designed for visualization —
 *  the result is small enough to lay out and render. Edges only connect nodes
 *  that are both in the returned set. */
export function neighborhood(
  functions: Map<string, FunctionRecord>,
  depth: Map<string, DepthInfo>,
  focus: string,
  upHops: number,
  downHops: number,
  recursiveSet?: ReadonlySet<string>,
  pinnedRoots?: ReadonlySet<string>
): GraphData {
  const focusRec = functions.get(focus);
  if (!focusRec) return { focus, nodes: [], edges: [] };

  // Reverse graph for caller traversal.
  const callers = new Map<string, Set<string>>();
  for (const fn of functions.values()) {
    for (const c of fn.callees) {
      if (!functions.has(c)) continue;
      if (!callers.has(c)) callers.set(c, new Set());
      callers.get(c)!.add(fn.name);
    }
  }

  const layerOf = new Map<string, number>();
  layerOf.set(focus, 0);

  // Node budget: hops are unbounded, so cap the total node count to keep the
  // graph renderable and the host responsive. When the budget is hit we stop
  // expanding and flag truncation.
  const NODE_BUDGET = 600;
  let budgetHit = false;

  // BFS downward (callees): layers 1..downHops
  let frontier = [focus];
  for (let h = 1; h <= downHops; h++) {
    const next: string[] = [];
    for (const n of frontier) {
      const rec = functions.get(n);
      if (!rec) continue;
      for (const c of rec.callees) {
        if (!functions.has(c)) continue;
        if (!layerOf.has(c)) {
          if (layerOf.size >= NODE_BUDGET) { budgetHit = true; break; }
          layerOf.set(c, h); next.push(c);
        }
      }
      if (budgetHit) break;
    }
    frontier = next;
    if (frontier.length === 0 || budgetHit) break;
  }

  // BFS upward (callers): layers -1..-upHops
  frontier = [focus];
  for (let h = 1; h <= upHops; h++) {
    const next: string[] = [];
    for (const n of frontier) {
      const cs = callers.get(n);
      if (!cs) continue;
      for (const c of cs) {
        if (!layerOf.has(c)) {
          if (layerOf.size >= NODE_BUDGET) { budgetHit = true; break; }
          layerOf.set(c, -h); next.push(c);
        }
      }
      if (budgetHit) break;
    }
    frontier = next;
    if (frontier.length === 0 || budgetHit) break;
  }

  // Build nodes.
  const nodes: GraphNode[] = [];
  for (const [name, layer] of layerOf) {
    const rec = functions.get(name)!;
    const info = depth.get(name);
    // Detect truncation: does this node have callees/callers not in the set?
    let truncCallees = false, truncCallers = false;
    for (const c of rec.callees) {
      if (functions.has(c) && !layerOf.has(c)) { truncCallees = true; break; }
    }
    const cs = callers.get(name);
    if (cs) for (const c of cs) {
      if (!layerOf.has(c)) { truncCallers = true; break; }
    }
    // Peak shown on the node is the function's OWN downward worst case
    // (entry-independent), matching the side-panel top card. The entry-
    // inclusive per-root peaks live in the side panel's per-root table.
    const peak = info?.cumulativeStack;
    const peakBounded = info?.cumulativeBounded;
    // Root marker: pinned roots are explicit entry points; a function with no
    // caller anywhere in the whole program is an "auto" root.
    const allCallers = callers.get(name);
    const callerless = !allCallers || allCallers.size === 0;
    let isRoot = false;
    let rootKind: "pinned" | "auto" | undefined;
    if (pinnedRoots?.has(name)) { isRoot = true; rootKind = "pinned"; }
    else if (callerless) { isRoot = true; rootKind = "auto"; }
    nodes.push({
      name,
      file: rec.file,
      nameLine: rec.nameLine,
      stackBytes: rec.stackBytes,
      peak,
      recursive: recursiveSet?.has(name) ?? info?.recursive ?? false,
      fpVerified: info?.fpVerified === true,
      hasUnboundFp: Array.isArray(info?.fpSites) && info!.fpSites!.some(s => s.overridden !== true),
      isRoot,
      rootKind,
      layer,
      truncatedCallees: truncCallees,
      truncatedCallers: truncCallers,
      isFocus: name === focus
    });
  }

  // Build edges (only between nodes in the set). Mark indirect edges from
  // fpCallsites (approved targets folded into callees but flagged there).
  const inSet = new Set(layerOf.keys());
  const edges: GraphEdge[] = [];
  const seen = new Set<string>();
  // Adjacency within the subgraph, for cycle-edge detection below.
  const adj = new Map<string, string[]>();
  for (const name of inSet) {
    const rec = functions.get(name)!;
    const indirectTargets = new Set<string>(rec.indirectCallees ?? []);
    // When the caller's fp call sites were manually bound (verified), its
    // indirect edges are exact, not over-approximated — flag them so the UI
    // can render them distinctly.
    const callerVerified = depth.get(name)?.fpVerified === true;
    const lf = layerOf.get(name) ?? 0;
    for (const c of rec.callees) {
      if (!inSet.has(c)) continue;
      const key = name + "->" + c;
      if (seen.has(key)) continue;
      seen.add(key);
      const lt = layerOf.get(c) ?? 0;
      const onFocus = (lf < lt && lt <= 0) || (lf >= 0 && lf < lt);
      const isIndirect = indirectTargets.has(c);
      const isSelf = c === name;
      edges.push({ from: name, to: c, indirect: isIndirect,
                   fpVerified: isIndirect && callerVerified,
                   offFocus: isSelf ? false : !onFocus });
      const a = adj.get(name) ?? []; a.push(c); adj.set(name, a);
    }
  }

  // Mark recursive edges: an edge from→to is part of a cycle when `to` can
  // reach `from` again through the subgraph (i.e. following edges from `to`
  // eventually returns to `from`). Self-loops (from===to) are always cyclic.
  // The subgraph is bounded, so this BFS-per-edge is cheap.
  function reaches(start: string, target: string): boolean {
    if (start === target) return true;
    const stack = [start];
    const visited = new Set<string>([start]);
    while (stack.length) {
      const n = stack.pop()!;
      for (const next of adj.get(n) ?? []) {
        if (next === target) return true;
        if (!visited.has(next)) { visited.add(next); stack.push(next); }
      }
    }
    return false;
  }
  for (const e of edges) {
    if (e.from === e.to || reaches(e.to, e.from)) e.recursive = true;
  }

  return { focus, nodes, edges, truncatedByBudget: budgetHit };
}

/** Enumerate up to `limit` distinct callee chains starting at `name`,
 *  sorted by totalStack descending. Cycle edges are dropped.
 *  Used for hover popups: "where does this function go". */
export function pathsFrom(
  functions: Map<string, FunctionRecord>,
  name: string,
  limit: number,
  maxDepth: number
): CallPath[] {
  const out: CallPath[] = [];
  const visiting = new Set<string>();
  const stack: string[] = [];

  function dfs(curr: string, depth: number) {
    if (out.length >= limit * 4) return;
    const fn = functions.get(curr);
    if (!fn) return;
    if (visiting.has(curr)) {
      // We hit a cycle re-entering `curr`. Record the prefix-chain that
      // looped, ending at the repeated node, marked truncated.
      const nodes = [...stack, curr];
      out.push({ nodes, totalStack: sumStack(functions, nodes), truncatedByCycle: true });
      return;
    }
    visiting.add(curr);
    stack.push(curr);
    const validCallees = fn.callees.filter(c => functions.has(c));
    if (validCallees.length === 0 || depth >= maxDepth) {
      // leaf or depth cap reached
      out.push({
        nodes: [...stack],
        totalStack: sumStack(functions, stack),
        truncatedByCycle: depth >= maxDepth
      });
    } else {
      for (const c of validCallees) dfs(c, depth + 1);
    }
    stack.pop();
    visiting.delete(curr);
  }
  dfs(name, 0);

  // Sort by stack descending, dedupe, take top N. Drop trivial single-node
  // paths if there are any multi-node paths (the single-node is implicit
  // in the summary line and just adds noise).
  const seen = new Set<string>();
  const unique: CallPath[] = [];
  const hasMultiNode = out.some(p => p.nodes.length > 1);
  for (const p of out.sort((a, b) => b.totalStack - a.totalStack)) {
    if (hasMultiNode && p.nodes.length === 1) continue;
    const key = p.nodes.join("\u0000");
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(p);
    if (unique.length >= limit) break;
  }
  return unique;
}

/** The single longest downward call chain from `name`, by node count — the
 *  path form of the "downDepth" metric (self = 1, each deeper level +1). It uses
 *  a memoized DFS over `callees` (fp targets are included, since they are a
 *  subset of `callees`), so it is O(V+E) and — unlike `pathsFrom` — is NOT
 *  bounded by a depth/stack limit. Its hop count therefore equals the analyzer's
 *  downDepth. Cycles are cut on first revisit (chain marked truncated, matching
 *  downDepthBounded). The side panel injects this into the "Calls into" list so
 *  that sorting by hops surfaces the same number shown in the Overview
 *  "Top by depth" list. */
export function longestPathFrom(
  functions: Map<string, FunctionRecord>,
  name: string
): CallPath {
  const bestMemo = new Map<string, string[]>();
  const boundedMemo = new Map<string, boolean>();
  const visiting = new Set<string>();

  function dfs(n: string): { nodes: string[]; bounded: boolean } {
    const cached = bestMemo.get(n);
    if (cached) { return { nodes: cached, bounded: boundedMemo.get(n) === true }; }
    if (visiting.has(n)) { return { nodes: [n], bounded: true }; }  // cycle: count once
    const fn = functions.get(n);
    if (!fn) { return { nodes: [n], bounded: false }; }
    visiting.add(n);
    let bestChild: string[] = [];
    let bounded = false;
    for (const c of fn.callees) {
      if (!functions.has(c)) { continue; }
      const sub = dfs(c);
      bounded = bounded || sub.bounded;
      if (sub.nodes.length > bestChild.length) { bestChild = sub.nodes; }
    }
    visiting.delete(n);
    const nodes = [n, ...bestChild];
    bestMemo.set(n, nodes);
    boundedMemo.set(n, bounded);
    return { nodes, bounded };
  }

  const r = dfs(name);
  return { nodes: r.nodes, totalStack: sumStack(functions, r.nodes), truncatedByCycle: r.bounded };
}

/** Enumerate up to `limit` distinct caller chains ending at `name`,
 *  sorted by totalStack descending. Cycles → truncated.
 *  Used for hover popups: "who reaches this function".
 *
 *  Algorithm: DFS on the reversed graph. We build `stack` as
 *  [self, caller1, caller2, …] (closest-to-self first), then reverse it
 *  on emit so the output reads root → … → self.
 *
 *  When `pinnedRoots` is supplied, DFS stops climbing as soon as it reaches
 *  a pinned root — the chain is recorded with the pinned root as its origin.
 *  This keeps incoming paths aligned with the depth numbers users see. */
export function pathsTo(
  functions: Map<string, FunctionRecord>,
  name: string,
  limit: number,
  maxDepth: number,
  pinnedRoots?: ReadonlySet<string>
): CallPath[] {
  const callers = new Map<string, string[]>();
  for (const fn of functions.values()) {
    for (const callee of fn.callees) {
      if (!functions.has(callee)) continue;
      const list = callers.get(callee) ?? [];
      list.push(fn.name);
      callers.set(callee, list);
    }
  }

  const out: CallPath[] = [];
  const visiting = new Set<string>();
  const stack: string[] = [];

  function dfs(curr: string, depth: number) {
    if (out.length >= limit * 4) return;
    if (visiting.has(curr)) {
      const nodes = [curr, ...stack].slice().reverse();
      out.push({ nodes, totalStack: sumStack(functions, nodes), truncatedByCycle: true });
      return;
    }
    visiting.add(curr);
    stack.push(curr);
    // If this node is a pinned root, treat as a leaf in the reverse walk —
    // emit the path here, don't climb past it. But still emit only if we
    // moved beyond `name` itself (otherwise we'd record self-only paths).
    const isPinnedHere = pinnedRoots?.has(curr) === true && curr !== name;
    const cs = isPinnedHere ? [] : (callers.get(curr) ?? []);
    if (cs.length === 0 || depth >= maxDepth) {
      out.push({
        nodes: [...stack].reverse(),
        totalStack: sumStack(functions, stack),
        truncatedByCycle: depth >= maxDepth
      });
    } else {
      for (const c of cs) dfs(c, depth + 1);
    }
    stack.pop();
    visiting.delete(curr);
  }
  dfs(name, 0);

  // Sort, dedupe. Always drop the trivial "self-only" path (length 1) and
  // self → self cycle artifacts that come from a function calling itself
  // directly — those are conveyed by the `recursive` flag in the summary,
  // and listing them as "incoming paths" is misleading.
  const seen = new Set<string>();
  const unique: CallPath[] = [];
  for (const p of out.sort((a, b) => b.totalStack - a.totalStack)) {
    if (p.nodes.length === 1) continue;
    if (p.truncatedByCycle && p.nodes.length === 2 && p.nodes[0] === p.nodes[1]) continue;
    const key = p.nodes.join("\u0000");
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(p);
    if (unique.length >= limit) break;
  }
  return unique;
}

function sumStack(functions: Map<string, FunctionRecord>, names: string[]): number {
  let total = 0;
  for (const n of names) {
    const f = functions.get(n);
    if (f?.stackBytes !== undefined) total += f.stackBytes;
  }
  return total;
}

/** Build name -> record map. If multiple definitions share a name (static
 *  functions in different files), the last one wins for graph purposes —
 *  we keep them all in a list for display but flatten for the graph. */
export function indexFunctions(records: FunctionRecord[]): Map<string, FunctionRecord> {
  const m = new Map<string, FunctionRecord>();
  for (const r of records) m.set(r.name, r);
  return m;
}

/** Compute call-depth and worst-case cumulative stack for each function.
 *
 *  Modes:
 *  - **Legacy (no pinned roots)**: every caller-less function is treated as
 *    a root; `depth(f)` = length of the longest reverse chain to f from any
 *    such root; `cumulativeStack(f)` = max forward chain stack from f.
 *    The DepthInfo gets a single perRoot entry with rootName "(auto)".
 *
 *  - **Pinned roots**: each pinned root is an independent analysis origin.
 *    For each root r and each function f reachable from r:
 *      depth_r(f)        = length of longest call chain r → ... → f
 *      cumStack_r(f)     = max stack along r → ... → f → ... → leaf
 *    Aggregates (DepthInfo.depth, .cumulativeStack) take the max across
 *    perRoot entries — preserving backwards compatibility with single-pill
 *    consumers.
 *
 *  The forward-graph cumulative stack from f is computed once and shared
 *  across roots: it only depends on the subgraph below f, not how f was
 *  reached. So perRoot.cumulativeStack[f] == cum(f) for every root that
 *  reaches f. This is intentional: it gives the same "downward worst case
 *  from f" answer regardless of entry, while depth varies per entry. */
export function computeDepths(
  functions: Map<string, FunctionRecord>,
  maxCumulativeDepth: number,
  pinnedRoots?: ReadonlySet<string>,
  conditionalBindings?: ReadonlyArray<any>
): Map<string, DepthInfo> {
  // NOTE: conditional function-pointer bindings are no longer used — the
  // libclang analyzer resolves indirect calls automatically. This parameter
  // is kept only for signature stability; it is ignored.
  const condByFn = new Map<string, Array<any>>();
  if (conditionalBindings) {
    for (const b of conditionalBindings) {
      if (!b.approved) continue;
      const list = condByFn.get(b.callsite.function) ?? [];
      list.push(b);
      condByFn.set(b.callsite.function, list);
    }
  }
  const hasConditional = condByFn.size > 0;

  // Given a function and the current path context, return the set of extra
  // callees that conditional bindings activate. Static callees are always
  // included by the caller; this only returns the conditional additions.
  const evalCond: any = null;
  function conditionalCallees(fnName: string, root: string, pathNodes: ReadonlySet<string>): string[] {
    if (!hasConditional) return [];
    const bindings = condByFn.get(fnName);
    if (!bindings) return [];
    const out: string[] = [];
    for (const b of bindings) {
      if (evalCond!(b.when, { root, pathNodes })) {
        if (functions.has(b.target)) out.push(b.target);
      }
    }
    return out;
  }

  // Build reverse graph: who calls me?
  const callers = new Map<string, Set<string>>();
  for (const fn of functions.values()) {
    if (!callers.has(fn.name)) callers.set(fn.name, new Set());
  }
  for (const fn of functions.values()) {
    for (const callee of fn.callees) {
      if (!functions.has(callee)) continue;
      if (!callers.has(callee)) callers.set(callee, new Set());
      callers.get(callee)!.add(fn.name);
    }
  }

  // Detect SCCs for recursion flagging.
  const sccOf = tarjanSCC(functions);
  const recursiveSet = new Set<string>();
  const sccSizes = new Map<number, number>();
  for (const id of sccOf.values()) sccSizes.set(id, (sccSizes.get(id) ?? 0) + 1);
  for (const [name, id] of sccOf.entries()) {
    if ((sccSizes.get(id) ?? 0) > 1) recursiveSet.add(name);
    else {
      const fn = functions.get(name);
      if (fn && fn.callees.includes(name)) recursiveSet.add(name);
    }
  }

  // Forward-graph cumulative stack from each function (independent of entry).
  // When conditional bindings exist, we fold their targets into the cum
  // computation as a WORST-CASE over-approximation: peak counts a
  // conditional target even on paths where the condition wouldn't hold.
  // Rationale: for stack-safety, over-approximating peak is safe (you never
  // under-report the worst case), whereas depth/path display stays
  // condition-accurate. The report flags that conditional peak is an upper
  // bound. (A fully path-sensitive peak is exponential; this is the safe
  // compromise.)
  const cumCondTargets = new Map<string, string[]>();
  if (hasConditional) {
    for (const [fnName, bindings] of condByFn) {
      const targets = bindings.map(b => b.target).filter(t => functions.has(t));
      if (targets.length > 0) cumCondTargets.set(fnName, targets);
    }
  }
  const cumMemo = new Map<string, { bytes: number; bounded: boolean }>();
  const visiting = new Set<string>();
  function cumOf(name: string, hops: number): { bytes: number; bounded: boolean } {
    const cached = cumMemo.get(name);
    if (cached) return cached;
    if (hops > maxCumulativeDepth) return { bytes: 0, bounded: true };
    if (visiting.has(name)) return { bytes: 0, bounded: true };
    const fn = functions.get(name);
    if (!fn) return { bytes: 0, bounded: false };
    visiting.add(name);
    let maxChild = 0;
    let bounded = false;
    const condAdds = cumCondTargets.get(name);
    const calleeIter = condAdds ? [...fn.callees, ...condAdds] : fn.callees;
    for (const callee of calleeIter) {
      if (!functions.has(callee)) continue;
      const r = cumOf(callee, hops + 1);
      bounded = bounded || r.bounded;
      if (r.bytes > maxChild) maxChild = r.bytes;
    }
    visiting.delete(name);
    const own = fn.stackBytes ?? 0;
    const result = { bytes: own + maxChild, bounded };
    if (!bounded) cumMemo.set(name, result);
    return result;
  }

  const haveAnyStack = (name: string): boolean => {
    const fn = functions.get(name);
    if (!fn) return false;
    if (fn.stackBytes !== undefined) return true;
    return fn.callees.some(c => functions.get(c)?.stackBytes !== undefined);
  };

  // Per-function (rootName -> {depth, peak}) accumulator. Peak is now
  // PATH-SENSITIVE: for a given root it is the worst-case stack of a full
  // chain root → … → fn → … → leaf that passes through fn. This makes peak
  // consistent with depth — a root that reaches fn via a long deep chain
  // shows a correspondingly larger peak than one reaching it directly.
  interface RootEntry { depth: number; peak: number | undefined; bounded: boolean; }
  const perRootData = new Map<string, Map<string, RootEntry>>();
  function addRootEntry(fn: string, root: string, depth: number, peak: number | undefined, bounded: boolean) {
    let m = perRootData.get(fn);
    if (!m) { m = new Map(); perRootData.set(fn, m); }
    const existing = m.get(root);
    if (existing === undefined) {
      m.set(root, { depth, peak, bounded });
    } else {
      // Keep the worst case across paths from this root: max depth and max peak
      // tracked independently (depth is "longest chain", peak is "heaviest chain").
      const newPeak = (existing.peak === undefined) ? peak
        : (peak === undefined ? existing.peak : Math.max(existing.peak, peak));
      m.set(root, {
        depth: Math.max(existing.depth, depth),
        peak: newPeak,
        bounded: existing.bounded || bounded
      });
    }
  }

  const usePinned = pinnedRoots && pinnedRoots.size > 0;

  // Set of root names that are "auto" (caller-less, not pinned). In pinned
  // mode these are analyzed as additional roots so genuine entry points that
  // don't match a rootPattern (e.g. main, an ISR, a callback) still appear.
  const autoRootSet = new Set<string>();

  if (usePinned) {
    // Identify auto roots: functions with no in-graph caller that aren't
    // already pinned. They become extra analysis origins.
    for (const name of functions.keys()) {
      if (pinnedRoots!.has(name)) continue;
      const cs = callers.get(name);
      if (!cs || cs.size === 0) autoRootSet.add(name);
    }
    // Roots to traverse = pinned ∪ auto.
    const allRoots = new Set<string>([...pinnedRoots!, ...autoRootSet]);
    // Forward DFS from each root, tracking both the longest depth and
    // the heaviest path-stack to each reachable function.
    for (const root of allRoots) {
      if (!functions.has(root)) continue;
      const distFromRoot = new Map<string, number>();
      distFromRoot.set(root, 1);
      const stack: Array<{ name: string; depth: number; onPath: Set<string> }> = [
        { name: root, depth: 1, onPath: new Set([root]) }
      ];
      while (stack.length > 0) {
        const top = stack.pop()!;
        const fn = functions.get(top.name);
        if (!fn) continue;
        // Peak is DOWNWARD-ONLY: the function's own frame plus the heaviest
        // chain of things it calls. It does NOT include the frames of callers
        // above it on the path — so a given function has the same peak from
        // every root that reaches it. (Depth still varies per root; peak does
        // not.) This answers "how much stack is this function responsible for
        // from here down".
        const downward = haveAnyStack(top.name) ? cumOf(top.name, 0) : undefined;
        const peakHere = downward ? downward.bytes : undefined;
        addRootEntry(top.name, root, top.depth, peakHere, downward?.bounded ?? false);

        const condAdds = conditionalCallees(top.name, root, top.onPath);
        const effectiveCallees = condAdds.length > 0
          ? [...fn.callees, ...condAdds]
          : fn.callees;
        for (const callee of effectiveCallees) {
          if (!functions.has(callee)) continue;
          if (top.onPath.has(callee)) continue;
          const newDepth = top.depth + 1;
          if (newDepth > maxCumulativeDepth + 1) continue;
          const prev = distFromRoot.get(callee);
          if (prev === undefined || newDepth > prev) {
            distFromRoot.set(callee, newDepth);
            const nextOnPath = new Set(top.onPath);
            nextOnPath.add(callee);
            stack.push({
              name: callee,
              depth: newDepth,
              onPath: nextOnPath
            });
          }
        }
      }
    }
  } else {
    // Legacy mode: caller-less functions are auto-roots. Each fn gets one
    // "(auto)" entry. Depth via reverse graph; peak is the downward cum
    // (there's no single path context in this mode).
    const depthMemo = new Map<string, number>();
    const onStack = new Set<string>();
    function depthOf(name: string): number {
      const cached = depthMemo.get(name);
      if (cached !== undefined) return cached;
      if (onStack.has(name)) return 0;
      onStack.add(name);
      let best = 0;
      const cs = callers.get(name);
      if (cs) for (const c of cs) {
        const d = depthOf(c);
        if (d > best) best = d;
      }
      onStack.delete(name);
      const result = best + 1;
      depthMemo.set(name, result);
      return result;
    }
    for (const name of functions.keys()) {
      const downward = haveAnyStack(name) ? cumOf(name, 0) : undefined;
      addRootEntry(name, "(auto)", depthOf(name), downward?.bytes, downward?.bounded ?? false);
    }
  }

  // Compose DepthInfo.
  const out = new Map<string, DepthInfo>();
  for (const name of functions.keys()) {
    const roots = perRootData.get(name);
    const stackKnown = haveAnyStack(name);
    const cumResult = stackKnown ? cumOf(name, 0) : undefined;
    const perRoot: PerRootAnalysis[] = [];
    if (roots && roots.size > 0) {
      for (const [rootName, entry] of roots) {
        perRoot.push({
          rootName,
          depth: entry.depth,
          cumulativeStack: entry.peak,
          cumulativeBounded: entry.bounded,
          isAuto: rootName === "(auto)" || autoRootSet.has(rootName)
        });
      }
      // Sort by peak desc, then depth desc for stable display.
      perRoot.sort((a, b) => {
        const ax = a.cumulativeStack ?? 0;
        const bx = b.cumulativeStack ?? 0;
        if (ax !== bx) return bx - ax;
        return b.depth - a.depth;
      });
    } else if (usePinned) {
      // Function exists but no root (pinned or auto) reaches it.
      perRoot.push({
        rootName: "(unreached)",
        depth: 1,
        cumulativeStack: cumResult?.bytes,
        cumulativeBounded: cumResult?.bounded
      });
    }
    // Aggregate (legacy) fields: depth = max over roots; cumulativeStack =
    // the downward-only cum (kept for the single-pill/top-by-peak consumers
    // that expect an entry-independent worst case).
    let maxDepth = 1;
    for (const p of perRoot) if (p.depth > maxDepth) maxDepth = p.depth;
    out.set(name, {
      depth: maxDepth,
      recursive: recursiveSet.has(name),
      cumulativeStack: cumResult?.bytes,
      cumulativeBounded: cumResult?.bounded,
      perRoot
    });
  }
  return out;
}

/** Tarjan's strongly-connected-components algorithm on the forward call graph. */
function tarjanSCC(functions: Map<string, FunctionRecord>): Map<string, number> {
  let index = 0;
  let sccId = 0;
  const indices = new Map<string, number>();
  const lowlinks = new Map<string, number>();
  const stack: string[] = [];
  const onStack = new Set<string>();
  const sccOf = new Map<string, number>();

  // Iterative Tarjan to avoid blowing the call stack on huge graphs.
  function strongconnect(start: string) {
    type Frame = { v: string; iter: Iterator<string>; };
    const frames: Frame[] = [];
    indices.set(start, index);
    lowlinks.set(start, index);
    index++;
    stack.push(start);
    onStack.add(start);
    frames.push({ v: start, iter: (functions.get(start)?.callees ?? [])[Symbol.iterator]() });

    while (frames.length > 0) {
      const top = frames[frames.length - 1];
      const next = top.iter.next();
      if (!next.done) {
        const w = next.value;
        if (!functions.has(w)) continue;
        if (!indices.has(w)) {
          indices.set(w, index);
          lowlinks.set(w, index);
          index++;
          stack.push(w);
          onStack.add(w);
          frames.push({ v: w, iter: (functions.get(w)?.callees ?? [])[Symbol.iterator]() });
        } else if (onStack.has(w)) {
          lowlinks.set(top.v, Math.min(lowlinks.get(top.v)!, indices.get(w)!));
        }
      } else {
        // done visiting children of top.v — pop frame, update parent's lowlink
        if (lowlinks.get(top.v) === indices.get(top.v)) {
          // root of an SCC — pop until we hit it
          let w: string;
          do {
            w = stack.pop()!;
            onStack.delete(w);
            sccOf.set(w, sccId);
          } while (w !== top.v);
          sccId++;
        }
        const finished = frames.pop()!.v;
        if (frames.length > 0) {
          const parent = frames[frames.length - 1].v;
          lowlinks.set(parent, Math.min(lowlinks.get(parent)!, lowlinks.get(finished)!));
        }
      }
    }
  }

  for (const name of functions.keys()) {
    if (!indices.has(name)) strongconnect(name);
  }
  return sccOf;
}
