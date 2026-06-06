# CLAUDE.md — project context for Claude Code

This file orients an AI assistant (or any new contributor) working on this repo.
Read it first. It is the single source of truth for architecture, conventions,
and the rules that prevent regressions.

---

## What this is

A VS Code extension — **C Call Depth & Stack Hints** — for static call-depth and
stack-usage analysis of C code, aimed at embedded / DO-178C-style review work.
It shows per-function stack usage and call depth as decorations/hovers, a side
panel for lookup, and an interactive call-graph webview.

**It is an engineering aid, NOT a tool-qualified (DO-178C) tool.**

---

## Architecture (one backend: libclang via a bundled Python CLI)

```
VS Code extension (TypeScript, src/ -> out/)
        │  spawns
        ▼
cdepth_cli/  (Python package)
        │  parses every TU in compile_commands.json with libclang (AST)
        │  reads GCC -fstack-usage .su files for frame sizes
        ▼
   JSON result  ->  extension renders decorations / panel / graph
```

There is **no clangd, no VS Code LSP, no GCC .expand parsing**. (Some old
comments still say "clangd" — they are stale; the real backend is libclang.)

### Runtime requirements (end user)
- Python 3 on PATH, `pip install libclang`
- `compile_commands.json` for the C project
- GCC `.su` files (`-fstack-usage`) for stack frames

---

## File map

### TypeScript extension (`src/` → compiled to `out/`)
- `extension.ts` — activation, command registration, wiring. Commands:
  refresh, clearCacheAndRefresh, focusSidePanel, showOutput, exportReport,
  generateFpOverrides, openGraph (+ openGraphFromRoot internal).
- `pythonBackend.ts` — spawns `cdepth_cli`, maps JSON. **mapResult maps the CLI
  field `peak` → `cumulativeStack`** used internally.
- `callGraph.ts` — graph types (`FunctionRecord`, `DepthInfo`, `GraphData`) +
  `neighborhood()` (graph for the webview), `pathsFrom`/`pathsTo`, `CallPath`.
- `graphView.ts` — the interactive call-graph **webview** (full editor panel).
  Contains a big `GRAPH_HTML = String.raw\`…\`` template with inline CSS+JS.
- `sidePanel.ts` — the side-panel **webview** (Function + Overview tabs). Big
  `getHtml()` returning an HTML template with inline CSS+JS.
- `displayProviders.ts` — editor decorations + hovers.
- `reporter.ts` — CSV/HTML export.
- `fpTemplate.ts` — builds the "Generate fp-overrides template" JSON.
- `logger.ts` — output channel.

### Python CLI (`cdepth_cli/`)
- `clang_builder.py` — libclang AST scan; builds the call graph; function-pointer
  resolution + fp-override matching + pinned-root logic.
- `analysis.py` — `compute_analysis`, Tarjan SCC (recursion flags), peak stack
  (downward-only, cycle-guarded, root-independent), per-root entries, byName DTO.
- `su_reader.py` — parse `.su` files. `report.py` — text report. `__main__.py` —
  CLI entry (`--root`, `--su-dir`, `--root-pattern`, `--fp-overrides`, …).

### Other
- `test/` — 16 suites. `run-all.js` — one-command runner (builds the sample
  workspace with `make`, generates analysis JSON, runs every suite).
- `workspace/` — a synthetic C project (1014 functions) used by tests, with a
  Makefile that emits `.su`. `icons/` — call-tree icon (png + activity svg).
- `README.md` user docs · `CHANGELOG.md` · `PUBLISHING.md` (GitHub + Marketplace)
  · `LICENSE` (MIT).

---

## Build / test / package

```bash
npm install            # deps (typescript, @types, @vscode/vsce, jsdom)
npm run compile        # src/*.ts -> out/*.js   (tsconfig: strict=false)
npm test               # = node run-all.js  -> "ALL RUN SUITES PASS ✓" (16/16)
npx @vscode/vsce package --allow-missing-repository   # -> .vsix
```

`npm test` needs Python 3 + `pip install libclang` + `make` + gcc to build the
sample workspace and produce analysis JSON. Without them, the JS-only suites
still run but the analysis-dependent ones are skipped/fail.

To debug the extension itself: open the folder in VS Code, press **F5** (Run
Extension). For stale-webview issues: Uninstall → fully quit VS Code → Install
from VSIX → Reload Window.

---

## ⚠️ Rules that prevent regressions (READ BEFORE EDITING)

1. **Edit `src/*.ts`, never `out/*.js`.** `out/` is generated. (In one past
   session the working dir reset and changes were made directly to `out/`; that
   created a painful src↔out desync. They are in sync now — keep it that way:
   change `src`, run `npm run compile`.)

2. **The webview templates are `String.raw`/backtick template literals**
   (`GRAPH_HTML` in graphView.ts, `getHtml()` return in sidePanel.ts). Inside
   them, **never put a backtick or `${` in a comment or JS string** — it breaks
   the template and the TypeScript compile. (This has bitten us repeatedly, e.g.
   a `` `name` `` in a comment.) After editing a webview, sanity-check the inline
   script compiles:
   ```bash
   node -e 'const s=require("fs").readFileSync("out/graphView.js","utf8");
     const c=s.match(/<script>([\s\S]*?)<\/script>/)[1].replace(/\$\{[^}]*\}/g,"0");
     new Function(c); console.log("webview script OK")'
   ```

3. **CSS:** avoid a generic `.hidden { display:none !important }`; use explicit
   display values (a past bug).

4. **Child-safety / weapons / etc.** are not relevant here; this is a static
   analysis tool. No special content concerns.

---

## Key design decisions (stable — don't silently reverse)

- **One backend:** libclang only. fp edges/peak are an initializer-based
  over-approximation; assignment/param analysis is template-only.
- **Root** = pinned (by `--root-pattern` on decl file) OR caller-less. A pattern
  ALWAYS pins, even if the function has callers; it never cuts an edge.
- **Peak** = downward-only, cycle-guarded, root-independent own peak. Per-root
  table entries are entry-inclusive.
- **Recursion** is always surfaced: BFS shortest-cycle fallback guarantees ≥1
  path for any real cycle (works for a 100-hop loop). Otherwise an honest note.
- **Graph edges:** halo underlay; self-loops drawn as arcs; arrowheads in a
  separate layer ABOVE nodes, direction-aligned. **Same-layer edges (two nodes
  in the same hierarchy level) are NOT drawn** (self-loops kept).
- **Graph hover:** highlights ONLY the directional call flow through the hovered
  node — strictly deeper downstream (`distDown(to) > distDown(from)`), strictly
  shallower upstream. Back-edges (deep→shallow) and same-level siblings stay dim.
  Adjacency is built from DRAWN edges only (so hidden same-layer edges don't
  brighten nodes).
- **Side panel:** Function tab (search+detail) + Overview tab (top-by-peak /
  recursive / unbound-fp). Default Function. Opening a fn auto-switches and
  closes autocomplete. Overview lists default collapsed. Path filters on all
  lists + the per-root table. State (open fn, tab, collapse, filters) persists
  across view switches (`retainContextWhenHidden` + getState/setState).
- **Top-by-peak list:** shows name + peak only (no depth). **Recursive list:**
  shows hop count ("self" / "N hops").
- **fp-overrides template:** match key is `caller` + `via` (fp variable/table
  name) — **no `line` field** (stable across edits). The analyzer still accepts a
  hand-added `line`.
- **Icon:** a call tree (root → 2 branches → 3 leaves).

---

## Test suites (16, all should pass)

webview-harness, graph-search-test, decoration-hover-test, fp-override-test,
generate-template-test, per-root-graph-test, context-menu-test,
collapsible-reveal-test, examples-count-test, peak-verify-test, pinned-root-test,
fp-advanced-test, fp-struct-runtime-test, fp-site-link-test, recursion-path-test,
edge-over-node-test. Run all with `npm test`.

When you change behavior, **add/adjust a test** in the matching suite. The
graph/webview suites use jsdom and exercise the real `GRAPH_HTML` / `getHtml()`.

---

## Current state / open items

- Version **1.35.0**. Published to GitHub (nothing-githb/c-call-depth) +
  Marketplace (publisher HALISTAHASAHIN). Placeholders filled.
- Call-graph view: recursion-specific coloring + the "recursion only" filter
  were removed (1.34.0); the `↻` text markers and side-panel recursion analysis
  remain.
- The `extensionDependencies` on clangd was **removed** (1.35.0) — confirmed no
  clangd API usage in `src/`; user-facing "clangd" strings reworded to libclang.
  (A few internal comments / `__main__.py` docstring may still say "clangd".)
- Possible cleanups (not yet done):
  - Add screenshots/GIFs to the README (biggest remaining Marketplace win).

---

## Conventions

- TypeScript with `strict: false` (untyped webview bodies compile as implicit
  any — intentional, keeps the ported webview code simple).
- Keep the `.vsix` small via `.vscodeignore` (no node_modules/test/workspace/src).
- Bump `version` in package.json per change; update `CHANGELOG.md`.
