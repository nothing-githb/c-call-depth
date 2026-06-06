# Screenshots / media for the Marketplace listing

Drop the captured files here with these exact names so the top-level `README.md`
references resolve (vsce rewrites the relative paths to raw GitHub URLs on
package, so they show on the Marketplace page):

| File | What to capture |
|------|-----------------|
| `call-graph.png` | "C Call Depth: Open call graph" focused on `dispatch_isr` (or `pv_top`), callers/callees = 2. Dark theme; capture just the graph panel (~1600×1000). |
| `side-panel.png` | The side panel — Overview tab "Top by peak stack", or the Function tab opened on `pv_top` / `recur_root` (shows Frame/Peak, callers, calls-into, recursion paths). Capture just the panel column. |
| `graph-hover.gif` | In the call graph, hover across 2–3 nodes so the directional call-flow highlight is visible. ~4–8 s loop, ~900–1000 px wide, < 5 MB. |

This folder is excluded from the packaged `.vsix` (see `.vscodeignore`) — the
images only need to live in the Git repo for the Marketplace page to fetch them.
