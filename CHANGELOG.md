# Changelog

All notable changes to the **C Call Depth & Stack Hints** extension are
documented here. This project adheres to [Semantic Versioning](https://semver.org/).

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
