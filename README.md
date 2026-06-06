# C Call Depth & Stack Hints

A VS Code extension that annotates C functions with **call depth** and
**worst-case stack usage**, designed as a development-time aid for static
stack analysis (e.g. when working toward DO-178C / ISO 26262 stack-usage
evidence).

![Interactive call graph — layered call hierarchy with per-function stack, severity colouring, and function-pointer edges](images/call-graph.png)

Each function definition gets one or more inline pills:

```
static int compute(int x)  ‹ via task_main · d:3 · f:48B · p:1.1KB ›
```

- **d** (depth) — longest call chain from a root to this function. `↻` marks
  a function in a recursive cycle (`↻?` when the cycle is only via a
  function-pointer table — see below).
- **f** (frame) — own stack frame in bytes, from `-fstack-usage`.
- **p** (peak) — worst-case cumulative stack from this function downward.
  A trailing `+` means a recursion cycle or the depth cap was hit, so the
  number is a lower bound.
- **via ROOT** — when you pin roots, a function reachable from several roots
  gets one pill per root, each with its own depth.

Markers: `📌` pinned root · `⚓` auto root (no callers) · `↻` certain recursion ·
`↻?` possible recursion (fn-pointer cycle) · `≀` resolved indirect call.

### Certain vs. possible recursion

The side panel has a **Recursive functions** section that separates two cases:

- **Certain (`↻`)** — a *direct* call edge participates in the cycle. This is
  real recursion.
- **Possible (`↻?`)** — the cycle exists only through function-pointer edges,
  which the analyzer over-approximates (an indirect call is assumed to reach
  *any* function the referenced table was initialized with). Such a cycle is a
  safe worst-case for stack bounding but may not be real recursion — e.g. if a
  function only ever calls `table[1]` but the table also contains the function
  itself, an over-approximated self-edge appears. Treat `↻?` as "review this",
  not "this definitely recurses".

## Requirements

- **Python 3** and the **`libclang`** package (`pip install libclang`, which
  ships its own native library — no separate LLVM/clangd install needed).
- **`compile_commands.json`** in your project (CMake:
  `-DCMAKE_EXPORT_COMPILE_COMMANDS=ON`; Make: `bear -- make`). The analyzer
  reads it to know which files to analyze and how to parse them.
- For stack numbers, build with **`-fstack-usage`** (produces `.su` files) and
  point `cCallDepth.suDirectory` at the build dir.

## How the call graph is built

The analyzer parses every translation unit listed in `compile_commands.json`
with **libclang** and extracts the call graph **directly from the AST**:

- Every function definition is found (including **static** functions), keyed by
  libclang's USR so the same extern function merges across files while
  same-named statics stay distinct.
- Each call expression in a function body resolves to its callee.
- **Function-pointer tables** are resolved automatically: the initializer of a
  table like `static fn_t vt[] = { a, b, c };` is read, and an indirect call
  through it is treated as potentially reaching any of those targets
  (worst-case over-approximation — the right default for stack analysis).

### Manual function-pointer verification (overrides)

The automatic over-approximation is safe but can be too broad — an indirect call
through a table is assumed to reach *every* entry, even when you know only some
are reachable in this build. You can pin the exact targets of a specific call
site with a JSON file (default `<workspace>/fp-overrides.json`, or set
`cCallDepth.fpOverridesPath`):

```jsonc
{
  "overrides": [
    {
      "caller": "dispatch_isr",     // function containing the indirect call (required)
      "via": "vector_table",         // fp variable/table invoked — stable matcher
      "file": "drivers/src/drivers.c", // optional; matched by basename
      "targets": ["isr_timer", "isr_uart"], // the verified target list
      "note": "only timer+uart wired in this configuration"
    }
  ]
}
```

A call site is identified by `caller` (required) plus `via` (the name of the
function-pointer variable/table being invoked). This pair is **stable across
source edits** — inserting code above the call site won't break the override,
because no line numbers are involved. The generated template uses exactly this
key (no `line` field). If a caller has only one fp call site, `caller` alone is
enough. Every discriminator you specify must match; the most specific matching
override wins. `file` (basename) is also matched when given. (A `line` field is
still accepted if you add one by hand, but it isn't generated or needed.)

The listed `targets` **replace** the auto-resolved candidates for that call site
(so you can both narrow the list and add targets the analyzer missed), and the
site is marked **verified** — its fp edges are then treated as exact, so a cycle
that runs through them is reported as certain (`↻`) rather than possible (`↻?`).
Editing this file re-runs analysis without re-parsing unchanged sources.

An override with **no `targets` and no `conditional` targets binds nothing**, so
it is ignored (with a warning in the output log) and the call site is left
**auto-estimated (not bound)** — it keeps the worst-case over-approximation and
still shows up under "Unbound function pointers". To actually bind a site you
must list at least one target (unconditional or conditional).

### Parameter callbacks

When a function pointer arrives as a **parameter** (e.g. `apply(cb, x)` calling
`cb(x)`), it can't be resolved from within the function. The
**Generate fp-overrides template** command analyzes the call hierarchy: it looks
at every caller of the enclosing function and collects the functions they pass
at that argument position, then pre-fills `targets` with those as a SUGGESTION
(the entry's `_hint` says so). This is template-only — it does not change edges
or peak — so you review the suggestion and bind it explicitly if correct.

The suggester handles several harder shapes:
- **Multi-level callbacks** — a callback forwarded through several parameter
  layers (`top(cb)` → `mid(cb)` → `bottom(cb)` → `cb()`) is traced back through
  the forwarding chain to the concrete function supplied at the head.
- **Multiple fp parameters** — each parameter position is resolved
  independently, so `apply2(a, b, x)` suggests the right target for `a` and `b`
  separately.
- **Struct-field assignment** — `dev.on_event = handler; … dev.on_event(x)`
  surfaces `handler` as a candidate, keyed by the field name. Runtime
  assignments are handled too: a field set conditionally or reassigned within a
  function yields exactly those branch targets; a field assigned in one function
  and invoked in another (e.g. a global struct configured by a `setup()`) falls
  back to the safe union of all assignments to that field (never missing one).
- **Array-of-struct fp fields** — `tbl[i].fn(x)` surfaces the table's targets.

In the side panel's **Function-pointer calls** section, each site's **line N** is
clickable (jumps straight to the indirect call in source), and each inferred
target is a clickable function link (opens it in the panel, with hover info and a
right-click menu) — so you can follow an fp edge without hunting for it.

#### Conditional targets

A call site can also resolve to different targets depending on the call context,
via a `conditional` list. Each entry has a `when` condition and the `targets`
that apply when it holds. Conditions are `fromRoot` (the traversal's entry
function), `callerContains` (a function present on the current call chain), and
`all` / `any` / `not` combinators:

```jsonc
{
  "overrides": [
    {
      "caller": "dispatch", "file": "m.c", "line": 7,
      "conditional": [
        { "when": { "fromRoot": "task_a" }, "targets": ["handler_a"] },
        { "when": { "fromRoot": "task_b" }, "targets": ["handler_b"] },
        { "when": { "all": [ { "callerContains": "init" },
                             { "any": [ { "fromRoot": "task_c" },
                                        { "not": { "fromRoot": "task_d" } } ] } ] },
          "targets": ["handler_c"] }
      ]
    }
  ]
}
```

Conditional targets appear in the graph and recursion check as *possible* edges,
but the **per-root peak** follows a conditional edge only from roots/paths where
its condition holds — so `dispatch` reached from `task_a` includes only
`handler_a`'s stack, and from `task_b` only `handler_b`'s. The function's own
(root-independent) top-card peak still treats every conditional edge as active
(absolute worst case).

### Collapsible sections & incremental lists

The side panel's sections — **Callers**, **Calls into**, **Recursion paths**,
**Recursive functions**, and **Unbound function pointers** — have collapsible
headers (click the ▶ to fold/unfold), and their open/closed state is remembered
across lookups. Long lists show a first batch and offer **show N more / show all
/ show less**, so a function with hundreds of callers stays readable.

The side panel is split into two tabs that separate the two ways you use it:

- **Function** — the search box and the per-function detail view (frame, peak,
  callers, calls-into, recursion paths, per-root analysis). Looking up or
  clicking any function opens it here, switching to this tab automatically.
- **Overview** — the always-on, workspace-wide lists: **Top by peak stack**,
  **Recursive functions**, and **Unbound function pointers**. The tab shows a
  badge with how many functions the analysis covers.

![Side panel — per-function detail: frame, peak, function-pointer call sites, per-root analysis, callers, and calls-into](images/side-panel.png)

The last-used tab is remembered, and clicking a function in any Overview list
jumps straight to its detail in the Function tab.

The **Top by peak stack**, **Recursive functions**, and **Unbound function
pointers** lists, and the **Per-root analysis** table, each have a filter box:
type part of an absolute file path (e.g. `src/drivers` or a full
`/path/to/file.c`) — or a function name — to narrow the list to that location,
with the matched path fragment highlighted. Clearing the box (or pressing
Escape) restores the full view. The overview lists start collapsed so the tab
opens compact; expand the ones you want, and that choice is remembered.

Switching to another sidebar view and back no longer loses your place: the open
function, the section collapse states, and the filters are retained, and the
detail view is restored automatically.

### Hover tooltips

Hovering a node in the call graph (or a function name in the side panel) shows a
tooltip with the function name plus a short summary: **Frame**, **Peak**, and
role bits (📌 pinned / ⚓ auto root, recursive ↻, fp bound ✓ or fp estimated). The
two views use the same wording so the information reads the same everywhere.

### Per-root → call graph shortcut

In the side panel's **Per-root analysis** table, each (non-pseudo) root row has a
small ⊹ button. Clicking it opens the call graph focused on that **root**, with
callers hidden and callees expanded just deep enough to reach the function you
were inspecting — so you see the exact root→…→function path. The target function
is briefly pulsed/highlighted on arrival.

There is no clangd, no LSP, and no GCC `.expand` dependency. Stack frames come
from `.su` files and are matched to functions by name.

```jsonc
// .vscode/settings.json
{
  "cCallDepth.suDirectory": "build",
  "cCallDepth.rootPatterns": ["**/app/**"]
}
```

## Configuration & standalone use

The bundled analyzer (`cdepth_cli`) can run both inside the extension and as a
standalone command. Configure via VS Code settings:

  ```jsonc
  {
    "cCallDepth.pythonPath": "python3",
    "cCallDepth.suDirectory": "build",
    "cCallDepth.rootPatterns": ["**/app/**"],
    "cCallDepth.libclangPath": "",
    "cCallDepth.clangArgs": []
  }
  ```

  Parse flags come entirely from `compile_commands.json` (per file) — the
  analyzer does not probe the system compiler for default include paths. A
  correct `compile_commands.json` already carries the include paths the build
  uses; if yours is missing some (or you target a cross toolchain), add the
  needed `-isystem`/`-I` flags via `clangArgs`.

  - `libclangPath` overrides libclang auto-detection — give the
    `libclang.so/.dylib/.dll` file or its directory (rarely needed).
  - `clangArgs` adds extra parse flags on top of `compile_commands.json`.
  - Warning flags from `compile_commands.json` (`-Wall`, `-Werror`,
    `-Wno-...`) are dropped automatically — they're irrelevant to the call
    graph and some are GCC-specific.

  The same analyzer runs standalone from a terminal (useful for CI):

  ```bash
  pip install libclang
  python -m cdepth_cli --root ./src --su-dir ./build \
      --root-pattern '**/app/**' --report stack.html --out result.json
  ```

  It analyzes exactly the translation units in `compile_commands.json` (set
  `cCallDepth.compileCommandsDir` / `--compile-commands-dir` if it isn't at the
  workspace root or a `build` subdir). If no `compile_commands.json` is found,
  or it lists no usable files, it stops with an error rather than guessing.

  **Version matching.** If you point `libclangPath` at your own
  `libclang.so/.dll`, its version should match the `clang.cindex` Python
  bindings (the `libclang` pip package). A mismatch makes the native library
  return AST node kinds the bindings don't know, surfacing as
  `Unknown ... kind N` (e.g. `unknown template argument kind 350`). The
  analyzer is defensive — it skips nodes it can't decode and keeps going — but
  for complete results, either let it use the bundled library (leave
  `libclangPath` empty) or install a matching `libclang` package version:
  `pip install "libclang==<your-llvm-major>.*"`.

## Pinned roots & per-root analysis

By default any function with no caller is a root (depth 1). For real codebases
you usually want to declare your architectural entry points explicitly — task
bodies, ISRs, public API. Use `rootPatterns` (globs over header paths):

```jsonc
{
  "cCallDepth.rootPatterns": ["**/components/*/public/**", "**/apps/public/**"]
}
```

Every function declared in a matching header becomes a **pinned root**: it gets
depth 1 *and* remains a starting point for analysis even if other code calls
it. A function reachable from several pinned roots is analyzed once per root,
and shows one pill per root. This matters for stack analysis: each entry point
is an independent worst-case origin.

## Function pointers

Indirect calls (`fp(x)`, `ops->read(x)`, `table[i](https://example.invalid/x)`) are invisible to a
plain static call graph. The extension resolves them from a reviewable
annotations file.

### 1. Scan for candidates

Run **`C Call Depth: Scan function-pointer call sites`**. It scans your `.c`
files, finds indirect call sites and address-taken functions, and writes a
draft annotations file with every entry `approved: false`.

### 2. Review and approve

Open the annotations file and, for each call site, set `approved: true` and
trim `targets` to the functions that can actually be called there:

```jsonc
{
  "version": 1,
  "callsites": [
    {
      "fp": "h",
      "function": "dispatch_irq",
      "file": "apps/isr.c",
      "line": 52,
      "targets": ["isr_timer", "isr_uart_rx", "isr_disk"],
      "approved": true,
      "note": "vector_table entries; see SRS-0100"
    }
  ]
}
```

Approved targets become edges in the graph and count toward peak. Re-running
the scanner never overwrites an approved entry — your review wins.

### 3. Conditional (context-sensitive) bindings

Sometimes a pointer's real target depends on **how** the call was reached. You
express that with `conditionalBindings`. Two condition types:

- `fromRoot(root)` — the analysis traversal started at pinned root `root`.
- `reachedThrough(node)` — the path to the call site passes through `node`.

Combine them with `and` / `or` (nestable). Example: `dispatch_irq`'s pointer
resolves to `isr_timer` at boot (`system_init` context) but to any of three
handlers at runtime (`runtime_loop` context):

```jsonc
{
  "version": 1,
  "callsites": [],
  "conditionalBindings": [
    {
      "callsite": { "function": "dispatch_irq", "fp": "h" },
      "target": "isr_timer",
      "when": { "type": "fromRoot", "root": "system_init" },
      "approved": true,
      "note": "boot: only the timer vector is wired"
    },
    {
      "callsite": { "function": "dispatch_irq", "fp": "h" },
      "target": "isr_disk",
      "when": {
        "type": "and",
        "conditions": [
          { "type": "fromRoot", "root": "runtime_loop" },
          { "type": "reachedThrough", "node": "net_init" }
        ]
      },
      "approved": true,
      "note": "runtime, only after the network path"
    }
  ]
}
```

On paths where a binding's condition holds, the target edge is added and depth
is path-accurate. On paths where **no** binding applies, the pointer stays
unresolved (flagged `⁉`) — that path simply doesn't account for the pointer.
Peak stack is computed as a **worst-case upper bound**: conditional targets
are counted regardless of path, so peak never under-reports. The hover spells
this out per function.

### Where the annotations file lives

By default `<workspaceRoot>/fp-annotations.json`. To use a different location
set `cCallDepth.fpAnnotationsPath` (relative resolves against the workspace
root; absolute is used as-is):

```jsonc
{
  "cCallDepth.fpAnnotationsPath": ".cdepth/fp-annotations.json"
}
```

The scanner writes to, and the analyzer reads from, this same path. The file
is plain JSON, meant to be committed to version control and reviewed — it is a
traceable record of every indirect-call resolution decision.

## Interactive call graph

**`C Call Depth: Open call graph`** opens a full-panel, interactive
node-link view of the call hierarchy. It shows a bounded neighborhood around
a *focus* function: callers fan out to the left, callees to the right, with
the focus in the center.

![Hover any node to trace its directional call flow — callers up, callees down, the rest dims out](images/graph-hover.gif)

- **Layered layout** — caller layers on the left (−1, −2…), focus in the
  middle, callee layers on the right (+1, +2…). Heavy nodes sort to the top
  of each layer.
- **Severity coloring** — node border/bar colored by peak stack
  (green/orange/red), gray when no stack data. Recursion marked `↻`,
  indirect (function-pointer) edges drawn dashed.
- **Navigate** — right-click a node for actions: *Open source*, *Make root
  (focus here)*, and *Show stack usage…* (opens the side-panel breakdown).
  The header and footer of the menu show the function name, own frame, and
  peak. A search box (top-left) jumps to any function.
- **Trace paths** — hover a node to highlight the directional call flow through
  it: callers leading up to it (each step shallower) and callees it reaches (each
  step deeper); the rest dims out. Only edges that follow the hierarchy are lit —
  same-level sibling calls and back-edges (e.g. a deep callee calling a shallower
  one) stay dim, so the flow reads cleanly.
- **File groups** — toggle "file groups" to wrap same-file nodes in labeled
  frames (one per file per column). Node colors stay severity-based; the
  frames are colored per file.
- **Depth controls** — the "callers" and "callees" steppers expand or
  contract how many hops each side shows (0–6). Nodes with hidden
  callers/callees are marked `…`.
- **Pan & zoom** — left-drag to pan, scroll to zoom; the view auto-fits on
  each refocus.
- **Readable edges** — every call edge is drawn over a background-colored halo,
  so lines stay legible where they pass over a node box or cross other edges. A
  **self-call** (direct self-recursion) is drawn as a small arc on top of the
  node — clearly visible rather than a hidden line through the box.

You can open it focused on a specific function from: the editor right-click
menu (on a C symbol), the **⊹ view in call graph** link in the hover, or the
**graph ⊹** button in the side panel.

## Reports

**`C Call Depth: Export report (CSV / HTML)`** writes a report, sorted with
the most critical first. It first asks what to include:

- **Roots only** — one row per entry point (pinned or auto root), each with its
  full downward peak. This is the usual stack-budget view: the worst-case stack
  each entry point needs.
- **All functions** — one row per (function, root) pair, for detailed tracing.

…then the format:

- **HTML** — severity-colored, opens in a browser, includes a summary and a
  limitations disclaimer.
- **CSV** — for spreadsheets, diffing, and traceability.

The standalone CLI mirrors this with `--report` / `--csv` and a `--roots-only`
flag.

## Commands

| Command | What it does |
|---|---|
| `C Call Depth: Refresh analysis` | Re-run the full pipeline. |
| `C Call Depth: Focus side panel` | Open the lookup/explorer panel. |
| `C Call Depth: Open call graph` | Open the interactive call-graph view. |
| `C Call Depth: Export report (CSV / HTML)` | Write a per-root report. |
| `C Call Depth: Show log` | Open the output log. |

## Settings

| Setting | Default | Meaning |
|---|---|---|
| `cCallDepth.suDirectory` | `""` | Directory scanned for `.su` files (stack frames). |
| `cCallDepth.compileCommandsDir` | `""` | Path to `compile_commands.json` or its directory. Empty = workspace root, then `build/`. |
| `cCallDepth.rootPatterns` | `[]` | Header globs whose declared functions become pinned roots. |
| `cCallDepth.pythonPath` | `python3` | Python 3 interpreter that runs the analyzer. |
| `cCallDepth.libclangPath` | `""` | libclang `.so/.dylib/.dll` file or its directory. Empty = auto-detect. |
| `cCallDepth.clangArgs` | `[]` | Extra parse flags appended to those from `compile_commands.json`. |
| `cCallDepth.displayMode` | `decoration` | `decoration` (pills) or `hover`. |
| `cCallDepth.maxDepthForCumulative` | `64` | Cap for cumulative-stack recursion. |
| `cCallDepth.pathsLimit` | `5` | Paths shown per direction in hover/panel. |
| `cCallDepth.pathsMaxDepth` | `32` | Max path length explored. Raise for very deep chains. |
| `cCallDepth.fpOverridesPath` | `""` | JSON of call-site fp overrides (manual verification/narrowing). Empty = `<workspace>/fp-overrides.json` if present. |
| `cCallDepth.logLevel` | `info` | `debug` \| `info` \| `warn` \| `error`. |

## How it works (pipeline)

1. **Parse** every translation unit in `compile_commands.json` with libclang;
   unchanged files are served from a per-TU cache (incremental).
2. **Call graph** extracted directly from the AST: function definitions (by
   USR, so statics stay distinct), direct call edges, and function-pointer
   table targets resolved automatically (over-approximated).
3. **`.su` matching**: stack frames matched to functions by name, file-
   qualified so same-named statics get their own frame.
4. **Pinned roots** applied from `rootPatterns` (matched on the declaration /
   header location).
5. **Depth + peak** computed per root; recursion is flagged (certain vs.
   possible-via-fp) and contributes a bounded lower bound.

## DO-178C / qualification note

This extension is **not a qualified tool**. The call graph is best-effort
(libclang AST), function-pointer targets are over-approximated, inline
assembly stack usage is not counted, and recursion contributes a lower bound.
Use it as a fast review aid during development. For Level A/B certification
evidence, use a qualified static stack analyzer (e.g. AbsInt StackAnalyzer),
and treat the annotations file and exported reports as review artifacts —
they cross-check nicely against a qualified tool's output.

## Development note

This extension was developed with the assistance of AI (Anthropic's Claude).
All output should be reviewed before being relied upon — and, as noted above,
this is an engineering aid, **not** a tool-qualified analyzer.
