# Changelog

All notable changes to the **C Stack Analysis & Call Graph** extension are
documented here. This project adheres to [Semantic Versioning](https://semver.org/).

## 1.43.0

- **Conditional edge removals are now global.** A removal with a `when` is
  evaluated statically against the call graph (`callerContains C` / `fromRoot C`
  = "C reaches the edge's caller", transitively, combined with `all`/`any`/`not`)
  and the matching edge is pruned from the **single shared graph** — so it now
  shows up in **every** view (call graph, own peak, downDepth, per-root
  Depth/Peak, Calls-into/Callers), not just the per-root numbers. Previously a
  conditional removal only affected per-root analysis.
- Call graph: **off-focus "cross" edges are no longer drawn** (the faint dashed
  links that don't lie on the focus's call flow); recursion/cycle back-edges are
  kept. Hovering a node now highlights **only the focus→node paths** — the node's
  own further sub-tree is no longer lit up.

## 1.42.1

- Fix: saving **edge-removals.json** (or fp-overrides.json / compile_commands.json,
  including a custom `edgeRemovalsPath` / `fpOverridesPath`) now reliably re-runs
  the analysis. The in-editor save handler recognises these config files directly
  instead of relying only on the file-system watcher, which some setups debounce
  or exclude.

## 1.42.0

- Edge removals: **`caller` is now optional**. Omit it (or use `"*"`) to remove
  the edge into `callee` from **any** caller. Combined with a `when`, this
  expresses "from any function, if a path comes through A it can't reach B"
  (`{ "callee": "B", "when": { "callerContains": "A" } }`). A caller-less
  removal without `when` drops every edge into `callee` (makes it uncalled).

## 1.41.0

- Edge removals can now be **conditional**: add a `when` to an entry
  (`{caller, callee, when}`) to drop the edge only on matching paths instead of
  globally. Conditions are `fromRoot` / `callerContains`, combinable with
  `all` / `any` / `not` — the same grammar as conditional fp-overrides. A
  conditional removal applies to the **per-root Depth / Peak** only; the global
  graph and root-independent own-peak keep the worst case. Removals without
  `when` stay unconditional (pruned everywhere).

## 1.40.1

- Per-root **Depth** is no longer silently capped near 65: the
  `cCallDepth.maxDepthForCumulative` default is raised from 64 to **256**, so
  deeper chains report their real depth (e.g. the 150-level sample now shows 151).
- Fix: a path cut by the depth limit is no longer mislabeled as a recursion
  cycle. Depth-limited chains are flagged separately (`truncatedByDepth`) and
  shown with **…** ("continues past the depth limit"); the **↻** marker is now
  reserved for chains that actually hit a recursion cycle, in both the side
  panel and hover.

## 1.40.0

- New: **edge removals** — prune impossible `caller → callee` calls via a JSON
  file (`cCallDepth.edgeRemovalsPath`, default `<workspace>/edge-removals.json`,
  `{removals:[{caller,callee,file?}]}`). The edge is removed wherever it appears
  (direct, fp/indirect, conditional), so it leaves the graph, peak, depth, and
  paths. The complement of fp-overrides (which narrow/verify rather than delete);
  the file auto-refreshes on change.
- Fix: the function detail's **Calls into** list, sorted by **hops**, now
  surfaces the function's deepest downward chain — so its top hop count matches
  the **Top by depth** (`d:N`) value in the Overview. The deepest chain is
  injected explicitly, so it is no longer dropped by the path list's depth cap
  (`pathsMaxDepth`) or its stack-based ranking.
- The function detail's **Callers** and **Calls into** lists now cap at 50
  paths (was 500), keeping the panel lighter; the deepest chain is still always
  shown (see above) and the call graph shows the full picture.
- Auto-refresh is now scoped to the build: a source-file save/change only
  re-runs the analysis when that file is a **translation unit listed in
  `compile_commands.json`**. Editing any other file (headers, sources not in
  the build, docs) no longer triggers a re-analysis — use the manual
  **Refresh analysis** command for those. (`.su`, `compile_commands.json`, and
  `fp-overrides.json` still auto-refresh as before.)
- Fix: the side panel no longer jumps from the **Overview** tab to the
  **Function** tab on its own. A background re-query (triggered when the
  analysis refreshes and a function detail was open) updated the detail and
  forced the Function tab; it now keeps you on Overview and only switches tabs
  for an explicit lookup.

## 1.39.2

- Report: the exported HTML report title is now **"C Stack Analysis & Call
  Graph — Report"** (was "C Call Depth Report"), matching the extension name.
- Docs: added more README screenshots — the side-panel **Overview** tab, the
  exported **HTML report**, and the call graph with **file groups** on. (Images
  live in `images/`, excluded from the packaged `.vsix`.)

## 1.39.1

- Docs: audited the README against the code and fixed the inconsistencies.
  Removed the stale "Function pointers" section that documented a non-existent
  `fp-annotations.json` / "Scan function-pointer call sites" workflow (the real
  `fp-overrides.json` mechanism is documented earlier). Updated the hover
  description to the focus-anchored corridor behaviour; documented the Overview
  "Top by depth" list and the Callers/Calls-into stack/hops sort toggle;
  completed the Commands and Settings tables (clear-cache & generate-template
  commands, `stackThresholds.*` settings); corrected the call-graph right-click
  menu labels, the "(0–6)" hop range, and a broken `table[i](x)` example. Also
  refreshed the `fpOverridesPath` setting description to the caller+via key.

## 1.39.0

- Function detail: the **Callers** and **Calls into** sections now have a
  **stack / hops** sort toggle — order the paths by total path stack (default)
  or by chain length (hop count). The choice persists across functions.

## 1.38.0

- Side panel **Overview** gained a **Top by depth** list next to "Top by peak
  stack": functions ranked by their deepest downward call chain (shown as
  `d:N`), with the same filter / collapsible / reveal behaviour. Surfaces the
  functions that head the deepest call structures.

## 1.37.1

- Call graph: left-clicking a node now **flashes the bottom hint** ("drag to
  pan … right-click for actions") to point you at the right-click actions (a
  left-click only highlights paths, so this nudges discovery).

## 1.37.0

- Call-graph hover is now **focus-anchored**: hovering a node highlights only the
  focus node's call flow that passes **through** the hovered node. Hovering a
  callee no longer lights up that callee's *other* callers that don't come from
  the focus (the off-focus "caller→callee" edge stays dim) — only calls related
  to the focus are shown. Hovering the focus still shows its whole flow; back-
  edges and same-level siblings remain excluded.

## 1.36.2

- Renamed the **Output** channel (and its status-bar tooltip) from "C Call
  Depth" to **C Stack Analysis & Call Graph**, matching the extension name.

## 1.36.1

- Lowercased the `publisher` id (`HALISTAHASAHIN` → `halistahasahin`) so the
  unique identifier renders as `halistahasahin.c-call-depth` everywhere.
  Marketplace publisher ids are case-insensitive, so this is the same publisher
  — existing installs update in place. No behavior change.

## 1.36.0

- Renamed the extension's display name from "C Call Depth & Stack Hints" to
  **C Stack Analysis & Call Graph** for clearer discoverability ("stack
  analysis" / "call graph" are what people search for). The extension **id**
  (`HALISTAHASAHIN.c-call-depth`) is unchanged, so existing installs update in
  place. No behavior change.

## 1.35.0

- **Removed the hard `extensionDependencies` on the clangd extension.** The
  analyzer uses libclang via the bundled Python CLI and never called the clangd
  extension API, so the dependency only forced an unnecessary install. Reworded
  the remaining user-facing "clangd" strings to "libclang".
- Marketplace metadata: clearer keyword-rich description, expanded keywords
  (embedded, firmware, rtos, DO-178C, ISO 26262, MISRA, …), more accurate
  categories (Visualization / Linters / Other), gallery banner, and `Free`
  pricing — all to improve discoverability. No behavior change.
- README now shows screenshots of the interactive call graph, the side panel,
  and an animated GIF of the hover call-flow trace (images excluded from the
  packaged `.vsix`).

## 1.34.0

- Call-graph view: removed recursion-specific **coloring** (the red recursive
  edge/arrow stroke and its legend entry) and the **"recursion only" filter**
  toggle. Self-loops are still drawn as arcs and functions remain marked with the
  `↻` glyph in node labels, tooltips, and the right-click info; the side panel's
  recursion analysis is unchanged.

## 1.33.0

- Restored the call-tree extension/activity-bar icons and the full README after
  a workspace reset; verified no code regressions.
- Repository hardening: source (`src/`) is now fully in sync with the compiled
  output, so `npm run compile` reproduces the shipped behavior exactly.

## 1.32.0

- Call-graph hover now highlights **only the directional call flow** through the
  hovered node: strictly deeper in the callee direction, strictly shallower
  toward the node in the caller direction. Back-edges (e.g. a level-3 callee
  calling a level-2 node) and same-level sibling edges stay dim.

## 1.31.0

- The generated **fp-overrides template no longer emits a `line` field**. Call
  sites are matched by `caller` + `via` (the function-pointer variable/table
  name), which is stable across source edits. A hand-added `line` is still
  accepted by the analyzer.

## 1.30.0

- Hover no longer brightens a node that is only reachable through a hidden
  same-layer edge; highlighting is built from the edges actually drawn.

## 1.29.0

- Edges between two nodes in the **same layer** are no longer drawn (they added
  visual clutter without conveying an up/down call step). Self-loops are kept.

## 1.28.0

- Hover highlighting restricted to the hovered node's call hierarchy; sibling
  and back edges that merely connect two kept nodes are excluded.

## 1.27.0

- New **call-tree icon** for the extension and the activity-bar view container.

## 1.24.0 – 1.26.0

- Recursive-functions list shows each cycle's hop count (self / N hops).
- Top-by-peak list shows function name and peak only.
- Icon iterations.

## 1.x (earlier)

- Side panel with Function and Overview tabs, path filters, collapsible
  sections, and persisted state across view switches.
- Interactive call-graph webview: layered node-link view, severity coloring,
  caller/callee depth steppers, per-root path view, recursion paths with a
  guaranteed shortest-cycle fallback.
- Function-pointer handling: initializer-based edge/peak over-approximation,
  plus a template suggester for multi-level callbacks, struct fields, and
  runtime-assigned pointers.
- Downward-only, root-independent peak stack computation with `-fstack-usage`.
- Pinned roots via path pattern.

## 0.x

- Initial libclang-based call-graph extraction and stack-usage decorations.
