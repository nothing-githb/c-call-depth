"""cdepth — standalone C call-depth / stack analysis via clangd (manual LSP).

Runs the full pipeline without VS Code and without GCC .expand:
  clangd (call graph)  +  .su files (stack frames)  →  depth / peak / per-root

Usage:
  python -m cdepth_cli --root SRC_DIR [--su-dir BUILD_DIR] \
      [--root-pattern 'glob' ...] [--clangd PATH] [--out result.json] \
      [--report report.html] [--json]

Examples:
  python -m cdepth_cli --root ./src --su-dir ./build --json
  python -m cdepth_cli --root . --su-dir build --report stack.html
"""

from __future__ import annotations

import argparse
import fnmatch
import json
import os
import sys
import time

from .clang_builder import (
    configure_libclang, load_compile_commands,
    find_compile_commands, ClangGraphBuilder,
)
from .su_reader import scan_su_directory
from .analysis import FunctionInfo, compute_analysis


def _match_root_patterns(path: str, patterns: list[str]) -> bool:
    if not patterns:
        return False
    norm = path.replace("\\", "/")
    for p in patterns:
        if fnmatch.fnmatch(norm, p):
            return True
    return False


def run(args) -> dict:
    log = (lambda m: print(f"[cdepth] {m}", file=sys.stderr)) if args.verbose else (lambda m: None)

    # Locate compile_commands.json — required, no walk fallback.
    cc = find_compile_commands(args.root, args.compile_commands_dir)
    if not cc:
        where = args.compile_commands_dir or f"{args.root} (or its build/ subdir)"
        print(f"[cdepth] ERROR: compile_commands.json not found in {where}. "
              f"Generate one (CMAKE_EXPORT_COMPILE_COMMANDS=ON, or 'bear -- make') "
              f"and set --compile-commands-dir if needed.", file=sys.stderr)
        raise SystemExit(2)
    files = load_compile_commands(cc)
    if not files:
        print(f"[cdepth] ERROR: {cc} contains no usable source entries.",
              file=sys.stderr)
        raise SystemExit(2)
    log(f"file set: {len(files)} file(s) from {cc}")

    # Load libclang.
    try:
        lib = configure_libclang(args.libclang)
        log(f"libclang: {lib}")
    except RuntimeError as e:
        print(f"[cdepth] ERROR: {e}", file=sys.stderr)
        raise SystemExit(3)

    # Parse flags come entirely from compile_commands.json (per file). Only
    # user-supplied --clang-arg flags are appended on top. No system-path
    # discovery: a correct compile_commands.json already carries the include
    # paths the build uses.
    extra_args = list(args.clang_arg)

    # Load optional call-site fp overrides (manual verification/narrowing).
    fp_overrides = []
    if args.fp_overrides:
        try:
            with open(args.fp_overrides, "r", encoding="utf-8") as f:
                doc = json.load(f)
            fp_overrides = doc.get("overrides", []) if isinstance(doc, dict) else doc
            if not isinstance(fp_overrides, list):
                fp_overrides = []
            log(f"loaded {len(fp_overrides)} fp override(s) from {args.fp_overrides}")
        except FileNotFoundError:
            log(f"fp-overrides file not found: {args.fp_overrides}")
        except (json.JSONDecodeError, OSError) as e:
            log(f"could not read fp-overrides: {e}")

    # Load optional edge removals (impossible caller→callee calls to prune).
    edge_removals = []
    if args.edge_removals:
        try:
            with open(args.edge_removals, "r", encoding="utf-8") as f:
                doc = json.load(f)
            edge_removals = doc.get("removals", []) if isinstance(doc, dict) else doc
            if not isinstance(edge_removals, list):
                edge_removals = []
            log(f"loaded {len(edge_removals)} edge removal(s) from {args.edge_removals}")
        except FileNotFoundError:
            log(f"edge-removals file not found: {args.edge_removals}")
        except (json.JSONDecodeError, OSError) as e:
            log(f"could not read edge-removals: {e}")

    # Split removals: unconditional ones are pruned globally from the graph;
    # conditional ones (with a "when") are applied per-root during analysis, so
    # the edge stays in the graph but is dropped only on matching paths.
    uncond_removals = [r for r in edge_removals if isinstance(r, dict) and not r.get("when")]
    cond_removals = [r for r in edge_removals if isinstance(r, dict) and r.get("when")]
    if cond_removals:
        log(f"{len(cond_removals)} conditional edge removal(s) (applied per-root)")

    gb = ClangGraphBuilder(log=log)
    graph = gb.build(files, extra_args, cache_dir=args.cache_dir,
                     fp_overrides=fp_overrides, edge_removals=uncond_removals)

    # Merge stack usage.
    su = scan_su_directory(args.su_dir) if args.su_dir else {}
    log(f"loaded {len(su)} stack-usage entr(ies)")

    by_file_func = getattr(su, "by_file_func", {})
    consumed_su: set[int] = set()  # id() of SuEntry objects already matched

    def _su_for(info):
        """Find the .su entry for a function record. Prefer a file-qualified
        match (so same-named statics in different files get their OWN frame),
        then fall back to the bare name."""
        bare = info.get("name", "")
        stem = os.path.splitext(os.path.basename(info["file"]))[0]
        e = by_file_func.get((stem, bare))
        if e is None:
            e = su.get(bare)
        if e is not None:
            consumed_su.add(id(e))
        return e

    def _removals_for(info):
        """Conditional removals attached to this caller: matched by bare name
        and (optional) file basename. Returns [{"callee", "cond"}]."""
        out_rm = []
        for r in cond_removals:
            caller = str(r.get("caller", ""))
            # caller omitted or "*" = any caller (the edge to `callee` is dropped
            # from EVERY function whenever the condition holds).
            if caller and caller != "*" and caller != info["name"]:
                continue
            rfb = os.path.basename(str(r.get("file", "")))
            if rfb and os.path.basename(info["file"]) != rfb:
                continue
            callee = str(r.get("callee", ""))
            if callee:
                out_rm.append({"callee": callee, "cond": r.get("when")})
        return out_rm

    functions: dict[str, FunctionInfo] = {}
    for name, info in graph.items():
        e = _su_for(info)
        functions[name] = FunctionInfo(
            name=name,
            file=info["file"],
            line=info["line"],
            callees=info["callees"],
            stack_bytes=e.bytes if e else None,
            stack_qualifier=e.qualifier if e else "",
            indirect_callees=info.get("indirect", []),
            decl_file=info.get("declFile", info["file"]),
            fp_verified=info.get("fpVerified", False),
            conditional_callees=info.get("conditional", []),
            removed_callees=_removals_for(info),
        )
    # Ghost records: in .su but not parsed (e.g. assembly, or a TU not in
    # compile_commands). Include so their stack still contributes — but skip
    # entries already consumed above (e.g. a bare name whose stack was claimed
    # by a suffix-disambiguated static), so we don't add phantom duplicates.
    for name, e in su.items():
        if name not in functions and id(e) not in consumed_su:
            functions[name] = FunctionInfo(
                name=name, file=e.file, line=max(0, e.line - 1),
                callees=[], stack_bytes=e.bytes, stack_qualifier=e.qualifier,
            )

    # Resolve pinned roots from patterns. Match against the function's
    # DECLARATION file (its header prototype when one exists), so a function
    # declared in a public header counts as an entry point regardless of which
    # .c defines it. Fall back to the definition file if there's no header.
    #
    # A pattern match ALWAYS pins the function as a root, even if it also has
    # callers: the user explicitly marked it an entry point, so its worst-case
    # stack must be analyzed from that entry. This does NOT remove it from the
    # call graph — peak is downward-only and root-independent, so any caller's
    # peak still includes this function's subtree (the edge is never cut).
    pinned = set()
    if args.root_pattern:
        for name, fi in functions.items():
            if _match_root_patterns(fi.decl_file, args.root_pattern):
                pinned.add(name)
        log(f"{len(pinned)} pinned root(s) from patterns (matched on declaration/header)")

    result = compute_analysis(functions, pinned_roots=pinned, max_depth=args.max_depth)
    # Carry fp call-site metadata (line + candidates + overridden) from the
    # graph into byName, so the extension can build an fp-overrides template.
    by = result.get("byName", {})
    for name, info in graph.items():
        sites = info.get("fpSites")
        if sites and name in by:
            by[name]["fpSites"] = sites
    result["meta"] = {
        "root": args.root,
        "suDir": args.su_dir,
        "fileCount": len(files),
        "functionCount": len(functions),
        "generatedAt": time.strftime("%Y-%m-%dT%H:%M:%S"),
    }
    return result


def main(argv=None):
    ap = argparse.ArgumentParser(prog="cdepth", description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--root", required=True, help="source root directory")
    ap.add_argument("--su-dir", default="", help="directory with GCC .su files")
    ap.add_argument("--root-pattern", action="append", default=[],
                    help="glob over file paths marking pinned roots (repeatable)")
    ap.add_argument("--compile-commands-dir", default="",
                    help="path to compile_commands.json, OR the directory "
                         "containing it (defaults to --root, then a 'build' subdir)")
    ap.add_argument("--libclang", default="",
                    help="path to libclang.so/.dylib/.dll (auto-detected if omitted)")
    ap.add_argument("--clang-arg", action="append", default=[],
                    help="extra argument passed to libclang when parsing "
                         "(repeatable), e.g. --clang-arg=-DMACRO=1. compile_commands.json "
                         "flags are used automatically; these are added on top.")
    ap.add_argument("--max-depth", type=int, default=256)
    ap.add_argument("--out", default="", help="write full result JSON to this path")
    ap.add_argument("--cache-dir", default="",
                    help="directory for per-TU parse cache (incremental "
                         "analysis: unchanged files aren't re-parsed)")
    ap.add_argument("--fp-overrides", default="",
                    help="path to a JSON file of call-site function-pointer "
                         "overrides {overrides:[{caller,file,line,targets[]}]} "
                         "to narrow/add indirect targets and mark them verified")
    ap.add_argument("--edge-removals", default="",
                    help="path to a JSON file of impossible call edges to prune "
                         "{removals:[{caller,callee,file?}]} — removes that "
                         "caller->callee edge (direct or fp) from the graph")
    ap.add_argument("--report", default="", help="write an HTML report to this path")
    ap.add_argument("--csv", default="", help="write a CSV report to this path")
    ap.add_argument("--roots-only", action="store_true",
                    help="reports include only entry-point (root) functions")
    ap.add_argument("--json", action="store_true", help="print result JSON to stdout")
    ap.add_argument("--verbose", action="store_true", help="log progress to stderr")
    args = ap.parse_args(argv)

    result = run(args)

    if args.out:
        with open(args.out, "w", encoding="utf-8") as f:
            json.dump(result, f, indent=2)
        print(f"wrote {args.out}", file=sys.stderr)
    if args.report:
        from .report import write_html_report
        write_html_report(result, args.report, roots_only=args.roots_only)
        print(f"wrote {args.report}", file=sys.stderr)
    if args.csv:
        from .report import write_csv_report
        write_csv_report(result, args.csv, roots_only=args.roots_only)
        print(f"wrote {args.csv}", file=sys.stderr)
    if args.json or (not args.out and not args.report and not args.csv):
        json.dump(result, sys.stdout, indent=2)
        print()
    return 0


if __name__ == "__main__":
    sys.exit(main())
