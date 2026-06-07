# Screenshots / media for the Marketplace listing

These files are referenced by the top-level `README.md`. vsce rewrites the
relative paths to raw GitHub URLs on package, so they show on the Marketplace
page. Most are rendered from the extension's real webview templates / report
HTML with sample data (headless Chrome screenshot), so they match the shipping
UI.

| File | What it shows |
|------|----------------|
| `call-graph.png` | Interactive call graph (hero) focused on `dispatch_isr` — layered layout, severity colors, function-pointer (dashed) edges, root markers. |
| `call-graph-filegroups.png` | The call graph with **file groups** on — same-file nodes wrapped in per-file colored frames. |
| `graph-hover.gif` | Hovering nodes in the call graph — the focus-anchored corridor highlight. |
| `side-panel.png` | Side panel **Function** tab: per-function detail (frame, peak, fp call sites, per-root table, callers, calls-into). |
| `overview.png` | Side panel **Overview** tab: Top by peak stack, Top by depth, Recursive functions, Unbound function pointers. |
| `report.png` | The exported **HTML report** — per-root stack budget, severity-colored, with summary and disclaimer. |

This folder is excluded from the packaged `.vsix` (see `.vscodeignore`) — the
images only need to live in the Git repo for the Marketplace page to fetch them.
