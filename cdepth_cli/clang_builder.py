"""Build a call graph by parsing every translation unit with libclang.

No clangd, no LSP, no open-file/index machinery. For each .c file in
compile_commands.json we parse a full AST and walk it:

  - FUNCTION_DECL + is_definition()  → the functions defined in this TU
  - within each function's subtree, CALL_EXPR.referenced  → its callees
  - identity across TUs is the cursor's USR (Unified Symbol Resolution):
      extern  → "c:@F@name"        (file-independent; merges across TUs)
      static  → "c:file.c@F@name"  (file-scoped; never collides)
  - indirect (function-pointer) calls: CALL_EXPR.referenced is the fp variable
    (or None). We additionally scan function-pointer table/variable
    initializers for DECL_REF_EXPR → FUNCTION_DECL, giving the set of
    candidate targets (a worst-case over-approximation), and attach them as
    callees of any function that performs an indirect call through that table.

The result is { name: {file, line, callees:[names], static, usr} }, keyed by
display name (with static disambiguation when names collide across files).
"""

from __future__ import annotations

import hashlib
import json
import os
import shlex
from typing import Callable, Optional

import clang.cindex as ci

from .edge_ops import apply_edge_removals


# ── libclang library discovery ──────────────────────────────────────────
def configure_libclang(explicit: str = "") -> str:
    """Point clang.cindex at a libclang shared library. Returns a description
    of what was used.

    `explicit` (from --libclang / cCallDepth.libclangPath) may be EITHER the
    full path to libclang.so/.dylib/.dll OR the directory that contains it —
    both are accepted. On Windows, libclang.dll may depend on sibling DLLs in
    the same folder; pointing at the *directory* lets the loader find them, so
    when a directory is given we use set_library_path (which keeps that folder
    on the search path).

    Order: explicit → CDEPTH_LIBCLANG env → the pip 'libclang' package's
    bundled native lib → common system locations. Raises if none work.
    """
    # 1) Explicit path: try directory-mode and file-mode as appropriate.
    if explicit:
        if os.path.isdir(explicit):
            # Directory containing libclang.{so,dll,dylib}.
            try:
                ci.Config.set_library_path(explicit)
                ci.Index.create()
                return f"{explicit} (directory)"
            except Exception as e:
                raise RuntimeError(
                    f"libclang directory '{explicit}' did not yield a loadable "
                    f"library: {e}")
        # Treat as a file path.
        if os.path.isfile(explicit):
            try:
                ci.Config.set_library_file(explicit)
                ci.Index.create()
                return explicit
            except Exception as e:
                # On Windows a bare file load can miss sibling DLLs; retry by
                # putting the containing directory on the search path.
                try:
                    ci.Config.set_library_path(os.path.dirname(explicit))
                    ci.Index.create()
                    return f"{os.path.dirname(explicit)} (directory)"
                except Exception:
                    raise RuntimeError(
                        f"could not load libclang at '{explicit}': {e}")
        raise RuntimeError(
            f"libclang path '{explicit}' does not exist (expected a "
            f"libclang.so/.dylib/.dll file or a directory containing one).")

    # 2) Auto-detect.
    candidates = []
    env = os.environ.get("CDEPTH_LIBCLANG")
    if env:
        candidates.append(env)
    # pip 'libclang' package ships its own native lib.
    try:
        import clang.native  # type: ignore
        nd = os.path.dirname(clang.native.__file__)
        candidates.append(os.path.join(nd, "libclang.so"))
        candidates.append(os.path.join(nd, "libclang.dylib"))
        candidates.append(os.path.join(nd, "libclang.dll"))
    except Exception:
        pass
    # Common system spots (Linux/macOS).
    for p in ("/usr/lib/llvm-18/lib/libclang.so.1",
              "/usr/lib/x86_64-linux-gnu/libclang-18.so.1",
              "/usr/lib/llvm-20/lib/libclang.so.1",
              "/usr/local/opt/llvm/lib/libclang.dylib"):
        candidates.append(p)

    last_err = None
    for c in candidates:
        if not c or not os.path.exists(c):
            continue
        try:
            ci.Config.set_library_file(c)
            ci.Index.create()
            return c
        except Exception as e:  # pragma: no cover
            last_err = e
            continue
    raise RuntimeError(
        "could not load a libclang shared library. Install the Python package "
        "'libclang' (pip install libclang), set --libclang / "
        "cCallDepth.libclangPath, or set the CDEPTH_LIBCLANG env var to a "
        f"libclang.so/.dylib/.dll (or its directory). Last error: {last_err}")


# ── compile flags ────────────────────────────────────────────────────────
_GCC_ONLY_FLAGS_PREFIX = ("-fstack-usage", "-fdump-", "-fdump-rtl")
_DROP_EXACT = {"-c", "-S", "-MMD", "-MD", "-MP"}


def _entry_args(entry: dict, directory: str) -> list[str]:
    """Extract clang-usable compiler args from a compile_commands entry.

    - makes include paths absolute
    - drops GCC-only / output flags
    - drops ALL warning flags (-W..., -w): warnings are irrelevant to call-graph
      extraction, some are GCC-specific and unknown to clang (e.g.
      -Wno-stringop-overflow), and -Werror could otherwise turn a clang-side
      warning into a fatal parse error.
    """
    if entry.get("arguments"):
        raw = list(entry["arguments"])
    else:
        raw = shlex.split(entry.get("command", ""))
    if raw:
        raw = raw[1:]  # drop the compiler name

    args: list[str] = []
    skip = False
    for i, a in enumerate(raw):
        if skip:
            skip = False
            continue
        if a in _DROP_EXACT:
            continue
        if a == "-o":
            skip = True
            continue
        if a.startswith(_GCC_ONLY_FLAGS_PREFIX):
            continue
        # Drop every warning flag: -W..., -Werror, -Wno-..., and bare -w.
        if a == "-w" or (a.startswith("-W") and a != "-W"):
            continue
        if a.endswith((".c", ".cc", ".cpp", ".cxx", ".o")):
            continue
        # Include dirs — handle both "-Ipath" and "-I path" (two tokens),
        # and "-isystem path". Absolutize relative paths.
        if a == "-I":
            if i + 1 < len(raw):
                inc = raw[i + 1]
                if inc and not os.path.isabs(inc):
                    inc = os.path.normpath(os.path.join(directory, inc))
                args.append("-I" + inc)
                skip = True
            continue
        if a.startswith("-I"):
            inc = a[2:]
            if inc and not os.path.isabs(inc):
                inc = os.path.normpath(os.path.join(directory, inc))
            args.append("-I" + inc)
            continue
        if a in ("-isystem", "-iquote", "-idirafter"):
            if i + 1 < len(raw):
                inc = raw[i + 1]
                if inc and not os.path.isabs(inc):
                    inc = os.path.normpath(os.path.join(directory, inc))
                args.append(a)
                args.append(inc)
                skip = True
            continue
        args.append(a)
    return args


# ── AST walking ────────────────────────────────────────────────────────
def _safe_kind(cursor):
    """Return cursor.kind, or None if libclang reports a kind value the
    Python bindings don't know (raises ValueError 'Unknown ... kind N').

    This happens when the loaded libclang library is a different/newer version
    than the clang.cindex bindings: the native side returns AST node kinds the
    bindings have no enum entry for. Rather than letting one exotic node abort
    the whole parse, we skip it.
    """
    try:
        return cursor.kind
    except ValueError:
        return None


def _is_func_def(c) -> bool:
    return _safe_kind(c) == ci.CursorKind.FUNCTION_DECL and c.is_definition()


def _function_pointer_targets(tu) -> dict[str, list[str]]:
    """Map fp variable USR → function names from its INITIALIZER only.

    Covers `static isr_fn_t table[] = { a, b, c };` and `fp_t f = some_func;`.
    This is what feeds the call graph edges and peak (analysis behavior is
    intentionally initializer-based — runtime reassignments are not folded into
    edges, to keep the analysis/override mentality stable).
    """
    out: dict[str, list[str]] = {}
    for c in tu.cursor.walk_preorder():
        if _safe_kind(c) != ci.CursorKind.VAR_DECL:
            continue
        targets: list[str] = []
        for node in c.walk_preorder():
            if _safe_kind(node) == ci.CursorKind.DECL_REF_EXPR:
                ref = node.referenced
                if ref and _safe_kind(ref) == ci.CursorKind.FUNCTION_DECL:
                    nm = ref.spelling
                    if nm and nm not in targets:
                        targets.append(nm)
        if targets:
            out[c.get_usr()] = targets
    return out


def _function_pointer_assignments(tu):
    """Map fp variable/field USR → assignment info for the fp-overrides template.

    Returns (by_var, scoped) where:
      by_var[usr]            = [func names assigned anywhere]   (global union)
      scoped[(usr, fn_usr)]  = [func names assigned inside fn_usr]

    The scoped map lets a call site prefer assignments made IN THE SAME function
    (precise: conditional/reassign/pointer-param) and fall back to the global
    union only when the calling function has none (e.g. a global struct whose
    field is assigned in a setup function and invoked elsewhere). Template-only;
    never affects edges or peak.
    """
    by_var: dict[str, list[str]] = {}
    scoped: dict[tuple, list[str]] = {}

    def _funcs_under(node) -> list[str]:
        names: list[str] = []
        for sub in node.walk_preorder():
            if _safe_kind(sub) == ci.CursorKind.DECL_REF_EXPR:
                ref = sub.referenced
                if ref and _safe_kind(ref) == ci.CursorKind.FUNCTION_DECL:
                    nm = ref.spelling
                    if nm and nm not in names:
                        names.append(nm)
        return names

    # Walk each function definition separately so we can attribute every
    # assignment to its enclosing function precisely (semantic_parent on
    # walk_preorder nodes is unreliable for this).
    for fn in tu.cursor.walk_preorder():
        if not _is_func_def(fn):
            continue
        try:
            fn_usr = fn.get_usr()
        except Exception:
            fn_usr = None
        for c in fn.walk_preorder():
            if _safe_kind(c) != ci.CursorKind.BINARY_OPERATOR:
                continue
            children = list(c.get_children())
            if len(children) != 2:
                continue
            lhs, rhs = children
            var = _lvalue_var_decl(lhs)
            if var is None:
                continue
            rhs_funcs = _funcs_under(rhs)
            if not rhs_funcs:
                continue
            vu = var.get_usr()
            lst = by_var.setdefault(vu, [])
            for nm in rhs_funcs:
                if nm not in lst:
                    lst.append(nm)
            if fn_usr is not None:
                slst = scoped.setdefault((vu, fn_usr), [])
                for nm in rhs_funcs:
                    if nm not in slst:
                        slst.append(nm)
    return by_var, scoped


def _lvalue_var_decl(node):
    """Resolve an assignment's left-hand side to the underlying VAR_DECL/FIELD
    cursor, drilling through casts/parens/member/array-subscript expressions."""
    stack = [node]
    while stack:
        n = stack.pop()
        k = _safe_kind(n)
        if k == ci.CursorKind.DECL_REF_EXPR:
            ref = n.referenced
            if ref and _safe_kind(ref) == ci.CursorKind.VAR_DECL:
                return ref
        if k == ci.CursorKind.MEMBER_REF_EXPR:
            ref = n.referenced
            if ref and _safe_kind(ref) in (ci.CursorKind.VAR_DECL, ci.CursorKind.FIELD_DECL):
                return ref
        for ch in n.get_children():
            stack.append(ch)
    return None


class ClangGraphBuilder:
    def __init__(self, log: Optional[Callable[[str], None]] = None):
        self._log = log or (lambda m: None)

    # Bump when the per-TU scan OUTPUT shape/semantics change, so stale caches
    # from older builds are invalidated automatically. v2: indirect sites carry
    # `via` + `extraCandidates`. v3: + `viaParam`/`callerName` + `argFuncs`
    # (inter-procedural parameter-callback suggestions).
    _SCAN_FORMAT = "5"

    def _cache_key(self, path: str, args: list[str]) -> Optional[str]:
        """A stable key for a TU: scan-format + source mtime+size + parse args.
        Headers it includes aren't tracked individually, so a header-only change
        isn't detected per-file — callers should clear the cache when headers
        change broadly (or rely on the .su/compile_commands triggers)."""
        try:
            st = os.stat(path)
        except OSError:
            return None
        h = hashlib.sha1()
        h.update(("fmt" + self._SCAN_FORMAT + "\x00").encode())
        h.update(path.encode("utf-8", "replace"))
        h.update(str(int(st.st_mtime)).encode())
        h.update(str(st.st_size).encode())
        h.update("\x00".join(args).encode("utf-8", "replace"))
        return h.hexdigest()

    def _cached_scan(self, path, args, index, cache_dir):
        """Return this TU's local scan dict, from cache if fresh, else by
        parsing. Sets local['_from_cache']=True on a hit."""
        key = self._cache_key(path, args) if cache_dir else None
        cache_file = os.path.join(cache_dir, key + ".json") if key else ""
        if cache_file and os.path.isfile(cache_file):
            try:
                cache_mtime = os.path.getmtime(cache_file)
                with open(cache_file, "r", encoding="utf-8") as f:
                    local = json.load(f)
                # Reject caches written by a different scan format (output shape
                # changed) — belt-and-suspenders alongside the format-tagged key,
                # so a stale-content file can never feed the new logic.
                if local.get("_scan_format") != self._SCAN_FORMAT:
                    raise ValueError("scan format mismatch")
                # Invalidate if any included header is newer than the cache
                # entry (the source file's own mtime is already in the key), or
                # if a previously-included header has vanished (deleted/renamed,
                # which changes how the TU compiles).
                stale = False
                for inc in local.get("_includes", []):
                    try:
                        if os.path.getmtime(inc) > cache_mtime:
                            stale = True
                            break
                    except OSError:
                        stale = True  # header gone → must re-parse
                        break
                if not stale:
                    local["_from_cache"] = True
                    return local
            except Exception:
                pass  # fall through to re-parse on any cache read error

        try:
            tu = ci.TranslationUnit.from_source(path, args=args, index=index)
        except Exception as e:
            self._log(f"parse failed: {path}: {e}")
            return None
        errs = [d for d in tu.diagnostics if d.severity >= ci.Diagnostic.Error]
        if errs:
            self._log(f"{os.path.basename(path)}: {len(errs)} parse error(s) "
                      f"(first: {errs[0].spelling})")
        try:
            local = self._scan_tu(tu, path)
        except Exception as e:
            self._log(f"{os.path.basename(path)}: AST scan aborted "
                      f"({type(e).__name__}: {e}); partial results kept. "
                      f"This often means the libclang library version "
                      f"doesn't match the Python bindings.")
            return None
        if cache_file:
            try:
                local["_scan_format"] = self._SCAN_FORMAT
                with open(cache_file, "w", encoding="utf-8") as f:
                    json.dump(local, f)
            except Exception:
                pass
        return local

    def _merge_local(self, local, records, raw_edges, fp_indirect, indirect_sites,
                     arg_funcs=None, param_fwd=None):
        """Fold one TU's local scan result into the global tables."""
        for usr, rec in local["records"].items():
            if usr not in records:
                records[usr] = rec
        for usr, name in local["edges"]:
            raw_edges.append((usr, name))
        # fp_indirect from cached/older results (kept for compatibility); the
        # authoritative indirect data now flows through indirect_sites below.
        for usr, names in local.get("fp_indirect", {}).items():
            lst = fp_indirect.setdefault(usr, [])
            for nm in names:
                if nm not in lst:
                    lst.append(nm)
        for site in local.get("indirect_sites", []):
            indirect_sites.append(site)
        # Merge (callee_name, arg_index) → [funcs passed], across all TUs, so a
        # parameter-based fp call can be resolved from callers in OTHER files.
        if arg_funcs is not None:
            for cn, ai, fns in local.get("argFuncs", []):
                lst = arg_funcs.setdefault((cn, ai), [])
                for nm in fns:
                    if nm not in lst:
                        lst.append(nm)
        # Merge parameter-forwarding edges across all TUs.
        if param_fwd is not None:
            for cn, ai, edges in local.get("paramFwd", []):
                lst = param_fwd.setdefault((cn, ai), [])
                for e in edges:
                    if e not in lst:
                        lst.append(e)

    def _scan_tu(self, tu, path):
        """Walk one TU's AST and return its LOCAL contribution as a plain dict
        (JSON-serializable), so it can be cached per file:
            { "records": {usr: rec}, "edges": [[usr, callee_name], ...],
              "fp_indirect": {usr: [names]} }
        """
        fp_targets = _function_pointer_targets(tu)        # initializer → edges
        fp_assign, fp_assign_scoped = _function_pointer_assignments(tu)  # template only
        records: dict[str, dict] = {}
        edges: list[list[str]] = []
        fp_indirect: dict[str, list[str]] = {}
        indirect_sites: list[dict] = []  # {caller_usr, line, targets[]}
        # (callee_name, arg_index) → [func names passed there]. Used to suggest
        # targets for a parameter-based fp call from what callers pass.
        arg_funcs: dict[tuple, list[str]] = {}
        # (callee_name, arg_index) → [[caller_fn, caller_param_idx], ...] when a
        # caller forwards one of its OWN parameters into that arg position. Lets
        # build() trace a callback through multiple forwarding levels back to the
        # concrete function supplied at the head of the chain.
        param_fwd: dict[tuple, list[list]] = {}
        for c in tu.cursor.walk_preorder():
            if not _is_func_def(c):
                continue
            usr = c.get_usr()
            name = c.spelling
            if usr not in records:
                is_static = c.storage_class == ci.StorageClass.STATIC
                def_file = os.path.abspath(str(c.location.file)) if c.location.file else path
                decl_file = def_file
                try:
                    canon = c.canonical
                    if canon is not None and canon.location.file is not None:
                        decl_file = os.path.abspath(str(canon.location.file))
                except Exception:
                    pass
                records[usr] = {
                    "usr": usr,
                    "name": name,
                    "file": def_file,
                    "declFile": decl_file,
                    "line": (c.location.line - 1) if c.location.line else 0,
                    "static": is_static,
                    "callee_names": [],
                }

            # Collect indirect (function-pointer) call sites individually, with
            # their line number and the candidate targets resolved at that site
            # (the fp variable/table being invoked). Tracking per call site —
            # rather than unioning everything in the function — lets a JSON
            # override pin the exact targets of one call site by (caller,file,line).
            for node in c.walk_preorder():
                if _safe_kind(node) != ci.CursorKind.CALL_EXPR:
                    continue
                ref = node.referenced
                if ref and _safe_kind(ref) == ci.CursorKind.FUNCTION_DECL:
                    cn = ref.spelling
                    if cn:
                        edges.append([usr, cn])
                    # Record any function passed AS AN ARGUMENT to this call,
                    # keyed by (callee_name, arg_index). This lets a parameter-
                    # based fp call inside `cn` be resolved by looking at what
                    # callers pass — an inter-procedural template SUGGESTION.
                    ai = 0
                    for arg in node.get_arguments():
                        for sub in arg.walk_preorder():
                            if _safe_kind(sub) == ci.CursorKind.DECL_REF_EXPR:
                                sref = sub.referenced
                                if sref and _safe_kind(sref) == ci.CursorKind.FUNCTION_DECL:
                                    fn_nm = sref.spelling
                                    if fn_nm:
                                        arg_funcs.setdefault((cn, ai), [])
                                        if fn_nm not in arg_funcs[(cn, ai)]:
                                            arg_funcs[(cn, ai)].append(fn_nm)
                                elif sref and _safe_kind(sref) == ci.CursorKind.PARM_DECL:
                                    # The caller forwards one of its OWN parameters
                                    # into cn's arg position ai. Record the edge
                                    # (cn, ai) <- (caller_fn, caller_param_idx) so a
                                    # multi-level callback chain can be traced back
                                    # to the concrete function at the chain head.
                                    cpi = _param_index_of(c, sref)
                                    if cpi is not None:
                                        param_fwd.setdefault((cn, ai), [])
                                        edge = [name, cpi]
                                        if edge not in param_fwd[(cn, ai)]:
                                            param_fwd[(cn, ai)].append(edge)
                        ai += 1
                    continue
                # Indirect call: resolve the fp variable/table → candidate targets.
                line = node.location.line if node.location and node.location.line else 0
                site_targets: list[str] = []
                extra_candidates: list[str] = []  # assignment-derived; template only
                via = ""   # name of the fp variable/table invoked (line-stable id)
                via_param = -1  # if the fp is a parameter, its 0-based index
                fp_var = _callee_fp_var(node)
                if fp_var is not None:
                    via = fp_var.spelling or ""
                    vu = fp_var.get_usr()
                    for tgt in fp_targets.get(vu, []):
                        if tgt not in site_targets:
                            site_targets.append(tgt)
                    # Assignment-derived candidates (template only; never edges
                    # or peak). Prefer assignments made IN THIS SAME function
                    # (precise for conditional/reassign/pointer-target cases);
                    # fall back to the global union of assignments to this field
                    # only when this function makes none — e.g. a global struct
                    # whose field is set in a setup() and invoked here.
                    scoped_tgts = fp_assign_scoped.get((vu, usr), [])
                    assign_tgts = scoped_tgts if scoped_tgts else fp_assign.get(vu, [])
                    for tgt in assign_tgts:
                        if tgt not in site_targets and tgt not in extra_candidates:
                            extra_candidates.append(tgt)
                    # If the fp is a PARAMETER of this function, note its index so
                    # build() can suggest targets from what callers pass.
                    pidx = _param_index_of(c, fp_var)
                    if pidx is not None:
                        via_param = pidx
                # Fallback: if we couldn't pin the fp variable, union every fp
                # table referenced in the function body (old coarse behavior),
                # so we never UNDER-approximate when resolution fails.
                if not site_targets:
                    for sub in c.walk_preorder():
                        if _safe_kind(sub) == ci.CursorKind.DECL_REF_EXPR:
                            sref = sub.referenced
                            if sref and _safe_kind(sref) == ci.CursorKind.VAR_DECL:
                                svu = sref.get_usr()
                                for tgt in fp_targets.get(svu, []):
                                    if tgt not in site_targets:
                                        site_targets.append(tgt)
                indirect_sites.append({"caller_usr": usr, "line": line,
                                       "via": via, "targets": site_targets,
                                       "extraCandidates": extra_candidates,
                                       "viaParam": via_param,
                                       "callerName": name})
        # Record the set of files this TU actually included, so the cache can
        # be invalidated when any header it depends on changes (not just the
        # .c itself). Best-effort: ignore if libclang can't enumerate them.
        includes: list[str] = []
        try:
            for inc in tu.get_includes():
                f = inc.include
                if f is not None:
                    includes.append(os.path.abspath(str(f.name)))
        except Exception:
            pass
        # Serialize arg_funcs / param_fwd (tuple keys aren't JSON-able).
        arg_funcs_list = [[cn, ai, fns] for (cn, ai), fns in arg_funcs.items()]
        param_fwd_list = [[cn, ai, edges] for (cn, ai), edges in param_fwd.items()]
        return {"records": records, "edges": edges, "fp_indirect": fp_indirect,
                "indirect_sites": indirect_sites,
                "argFuncs": arg_funcs_list,
                "paramFwd": param_fwd_list,
                "_includes": sorted(set(includes))}

    def build(self, files: list[tuple[str, list[str]]],
              extra_args: list[str], cache_dir: str = "",
              fp_overrides: list = None,
              edge_removals: list = None) -> dict[str, dict]:
        """files: list of (path, per-file-args). extra_args appended to every
        parse. Returns name → record.

        fp_overrides: optional list of call-site overrides, each a dict
            {caller, file, line, targets:[names]}. When an indirect call site
            matches (by caller name + file basename + line), its candidate
            targets are REPLACED by the listed ones (narrow and/or add), and
            that site is marked verified (no longer an over-approximation).

        When `cache_dir` is set, each TU's local scan result is cached there
        keyed by the source file's mtime+size and its parse args, so unchanged
        TUs are not re-parsed on the next run (incremental analysis). A TU is
        re-parsed only when its file (or its flags) change.
        """
        index = ci.Index.create()

        usr_to_name: dict[str, str] = {}
        records: dict[str, dict] = {}      # usr → record
        raw_edges: list[tuple[str, str]] = []  # (caller_usr, callee_name)
        fp_indirect: dict[str, list[str]] = {}  # caller_usr → fp target names
        indirect_sites: list[dict] = []    # {caller_usr, line, targets[]}
        arg_funcs: dict[tuple, list[str]] = {}  # (callee_name, arg_idx) → [funcs]
        param_fwd: dict[tuple, list[list]] = {}  # (callee, ai) → [[caller, cpi], ...]

        if cache_dir:
            try:
                os.makedirs(cache_dir, exist_ok=True)
            except Exception:
                cache_dir = ""

        total_parsed = 0
        cache_hits = 0
        for path, file_args in files:
            args = file_args + extra_args
            local = self._cached_scan(path, args, index, cache_dir)
            if local is None:
                continue
            if local.get("_from_cache"):
                cache_hits += 1
            else:
                total_parsed += 1
            self._merge_local(local, records, raw_edges, fp_indirect,
                              indirect_sites, arg_funcs, param_fwd)

        self._log(f"parsed {total_parsed}/{len(files)} TU(s)"
                  + (f", {cache_hits} from cache" if cache_dir else "")
                  + f", {len(records)} function definition(s)")

        # Apply per-call-site fp overrides, then fold indirect call sites into
        # edges + fp_indirect. An override matches a site by caller NAME + file
        # basename + line. Unconditional `targets` replace the resolved
        # candidates and mark the caller verified. `conditional` entries ADD
        # targets that are only active when their condition holds; they are
        # recorded with the condition so the analyzer can filter them per-root.
        verified_callers: set[str] = set()
        # caller_usr → list of {targets:[names], cond:<dict>}
        cond_edges: dict[str, list] = {}
        # caller_usr → list of {line, via, candidates:[names], overridden:bool}
        # for building an fp-overrides.json template of unresolved call sites.
        fp_sites: dict[str, list] = {}
        # Parsed overrides: each is (i, caller, file_base, line|None, via|None,
        # targets, cond_list). A site matches when caller matches AND every
        # SPECIFIED discriminator (line and/or via) matches. `line` is optional;
        # `via` (the fp variable/table name) is line-stable.
        parsed_ovs: list = []
        for i, ov in enumerate(fp_overrides or []):
            try:
                caller = str(ov["caller"])
            except (KeyError, TypeError):
                self._log(f"fp-override #{i} ignored (needs caller; "
                          f"plus line and/or via to disambiguate)")
                continue
            fb = os.path.basename(str(ov.get("file", "")))
            ln = ov.get("line")
            ln = int(ln) if isinstance(ln, (int, float)) or (isinstance(ln, str) and ln.isdigit()) else None
            via = str(ov.get("via", "")) or None
            tgts = list(ov.get("targets", []))
            cond = ov.get("conditional", []) or []
            # An override with no targets AND no conditional binds nothing. Reject
            # it so the call site stays auto-ESTIMATED and shows as "not bound"
            # (rather than being silently marked overridden with no effect).
            cond_has_targets = any((c or {}).get("targets") for c in cond)
            if not tgts and not cond_has_targets:
                self._log(f"fp-override #{i} ({caller}) ignored — no targets and no "
                          f"conditional targets; nothing to bind. The call site is "
                          f"left auto-estimated (not bound).")
                continue
            parsed_ovs.append((i, caller, fb, ln, via, tgts, cond))
        ov_used: set[int] = set()

        def _match_override(cname, cbase, line, via):
            """Find the override matching this site. caller must match; file (if
            given) must match basename; line (if given) must match; via (if
            given) must match. Among candidates, prefer the most specific."""
            best = None
            best_score = -1
            for (i, caller, fb, ln, ov_via, tgts, cond) in parsed_ovs:
                if caller != cname:
                    continue
                if fb and fb != cbase:
                    continue
                if ln is not None and ln != line:
                    continue
                if ov_via is not None and ov_via != via:
                    continue
                # Score: more specified discriminators = more specific match.
                score = (1 if ln is not None else 0) + (1 if ov_via is not None else 0) + (1 if fb else 0)
                if score > best_score:
                    best_score = score
                    best = (i, tgts, cond)
            return best
        for site in indirect_sites:
            cusr = site["caller_usr"]
            crec = records.get(cusr)
            if crec is None:
                continue
            cname = crec["name"]
            cbase = os.path.basename(crec["file"])
            line = site.get("line", 0)
            via = site.get("via", "")
            vp = site.get("viaParam", -1)
            # Over-approximation removed: auto-resolved fp candidates NO LONGER
            # become edges or affect peak/depth, and are not suggested. ONLY an
            # fp-override binds targets. The call SITE is still recorded so the UI
            # can show where the function-pointer call is (so users can bind it).
            targets = []
            candidates = []
            overridden = False
            match = _match_override(cname, cbase, line, via)
            if match is not None:
                idx, ov_targets, cond_list = match
                ov_used.add(idx)
                overridden = True
                if ov_targets:
                    targets = list(ov_targets)    # bound by the override
                    candidates = list(ov_targets)
                    verified_callers.add(cusr)
                for ce in cond_list:
                    ctgts = list(ce.get("targets", []))
                    cwhen = ce.get("when")
                    if not ctgts or cwhen is None:
                        continue
                    cond_edges.setdefault(cusr, []).append(
                        {"targets": ctgts, "cond": cwhen})
                    for t in ctgts:
                        if t not in targets:
                            targets = list(targets) + [t]
                        if t not in candidates:
                            candidates.append(t)
            fp_sites.setdefault(cusr, []).append({
                "line": line, "via": via, "candidates": candidates,
                "overridden": overridden, "viaParam": vp if vp is not None else -1})
            for tgt in targets:
                raw_edges.append((cusr, tgt))
                lst = fp_indirect.setdefault(cusr, [])
                if tgt not in lst:
                    lst.append(tgt)
        for (i, caller, fb, ln, ov_via, tgts, cond) in parsed_ovs:
            if i not in ov_used:
                disc = []
                if ln is not None: disc.append(f"line {ln}")
                if ov_via: disc.append(f"via {ov_via}")
                self._log(f"fp-override #{i} ({caller}"
                          + (" " + ", ".join(disc) if disc else "")
                          + ") matched no indirect call site")

        # Build a name → preferred USR table. Extern names map to their single
        # global USR. For statics we keep them keyed by name but disambiguate
        # only if a collision with another file occurs.
        name_to_usrs: dict[str, list[str]] = {}
        for usr, rec in records.items():
            name_to_usrs.setdefault(rec["name"], []).append(usr)

        # Decide the display key for every USR up front, so edges and the .su
        # match use the SAME name. When a plain name maps to more than one USR
        # (same-named statics in different files), suffix EVERY one of them with
        # its file stem — including the first — so none silently wins the plain
        # name and loses its identity (which previously dropped its .su stack).
        usr_to_key: dict[str, str] = {}
        for name, usrs in name_to_usrs.items():
            if len(usrs) == 1:
                usr_to_key[usrs[0]] = name
            else:
                for u in usrs:
                    stem = os.path.splitext(os.path.basename(records[u]["file"]))[0]
                    usr_to_key[u] = f"{name}@{stem}"

        # Resolve raw edges (caller_usr, callee_name) → callee record, then
        # record the edge using the callee's DISPLAY KEY (suffix-aware), not the
        # bare name, so a call to a colliding static points at the right one.
        for caller_usr, callee_name in raw_edges:
            usrs = name_to_usrs.get(callee_name)
            if not usrs:
                continue  # callee not defined in our file set (extern lib)
            # Prefer a unique definition; if multiple (static collisions),
            # prefer one in the same file as the caller, else first.
            callee_usr = usrs[0]
            if len(usrs) > 1:
                caller_file = records[caller_usr]["file"]
                same = [u for u in usrs if records[u]["file"] == caller_file]
                if same:
                    callee_usr = same[0]
            lst = records[caller_usr]["callee_names"]
            cn = usr_to_key[callee_usr]
            if cn not in lst:
                lst.append(cn)

        # Emit display-name-keyed result using the precomputed keys.
        def _resolve_key(callee_name, caller_usr):
            usrs2 = name_to_usrs.get(callee_name)
            if not usrs2:
                return None
            cu = usrs2[0]
            if len(usrs2) > 1:
                cf = records[caller_usr]["file"]
                same2 = [u for u in usrs2 if records[u]["file"] == cf]
                if same2:
                    cu = same2[0]
            return usr_to_key[cu]

        out: dict[str, dict] = {}
        for usr, rec in records.items():
            key = usr_to_key[usr]
            cond_out = []
            for ce in cond_edges.get(usr, []):
                resolved = [_resolve_key(t, usr) for t in ce["targets"]]
                resolved = [r for r in resolved if r]
                if resolved:
                    cond_out.append({"targets": resolved, "cond": ce["cond"]})
            out[key] = {
                "name": rec["name"],          # bare name, for .su matching
                "file": rec["file"],
                "declFile": rec.get("declFile", rec["file"]),
                "line": rec["line"],
                "callees": rec["callee_names"],
                "static": rec["static"],
                "usr": usr,
                "indirect": fp_indirect.get(usr, []),
                "fpVerified": usr in verified_callers,
                "conditional": cond_out,
                "fpSites": sorted(fp_sites.get(usr, []), key=lambda s: s["line"]),
            }

        # Prune explicitly-excluded caller→callee edges (impossible calls) last,
        # so they leave the graph, peak, depth, and paths entirely. See edge_ops.
        apply_edge_removals(out, edge_removals, self._log)
        return out


def _callee_fp_var(call_expr):
    """For an indirect CALL_EXPR, return the cursor of the function-pointer
    variable / parameter / struct-field being invoked, if resolvable (so we can
    look up its targets, or — for a parameter — analyze what callers pass).

    Returns a VAR_DECL, PARM_DECL, or FIELD_DECL cursor. Struct-field invokes
    (`dev.on_event(x)`) resolve to the FIELD_DECL so they line up with the
    field's assignment targets collected in _function_pointer_assignments."""
    # The first child of a CALL_EXPR is the callee expression.
    children = list(call_expr.get_children())
    if not children:
        return None
    callee_expr = children[0]
    # Drill through casts/unexposed/paren to a DECL_REF_EXPR (var/param) or a
    # MEMBER_REF_EXPR (struct field). Prefer the field for member invokes.
    stack = [callee_expr]
    while stack:
        node = stack.pop()
        k = node.kind
        if k == ci.CursorKind.MEMBER_REF_EXPR:
            ref = node.referenced
            if ref and ref.kind == ci.CursorKind.FIELD_DECL:
                return ref
        if k == ci.CursorKind.DECL_REF_EXPR:
            ref = node.referenced
            if ref and ref.kind in (ci.CursorKind.VAR_DECL, ci.CursorKind.PARM_DECL):
                return ref
        for ch in node.get_children():
            stack.append(ch)
    return None


def _param_index_of(fn_cursor, parm_cursor):
    """If parm_cursor is one of fn_cursor's parameters, return its 0-based
    index; otherwise None. Used to map a parameter-based fp call to the argument
    position callers must supply."""
    if parm_cursor is None or _safe_kind(parm_cursor) != ci.CursorKind.PARM_DECL:
        return None
    try:
        parm_usr = parm_cursor.get_usr()
    except Exception:
        parm_usr = None
    idx = 0
    for arg in fn_cursor.get_arguments():
        if arg == parm_cursor or (parm_usr and arg.get_usr() == parm_usr):
            return idx
        idx += 1
    return None


# ── compile_commands helpers (shared shape with the rest of the CLI) ─────
def find_compile_commands(root: str, explicit: str = "") -> Optional[str]:
    """Locate compile_commands.json.

    `explicit` may be either the directory that contains compile_commands.json
    OR the full path to the file itself — both are accepted. Search order:
    explicit (file or dir) → root → a 'build' subdir → first found by walking.
    """
    candidates = []
    if explicit:
        if explicit.endswith(".json") or os.path.isfile(explicit):
            # User gave the file path directly.
            candidates.append(explicit)
        # Also treat it as a directory containing the file.
        candidates.append(os.path.join(explicit, "compile_commands.json"))
    candidates.append(os.path.join(root, "compile_commands.json"))
    candidates.append(os.path.join(root, "build", "compile_commands.json"))
    for c in candidates:
        if os.path.isfile(c):
            return c
    # No recursive walk: we only ever look at the explicit location, the root,
    # and a conventional build/ subdir. If it's elsewhere, the user points us
    # at it with --compile-commands-dir.
    return None


def load_compile_commands(cc_path: str) -> list[tuple[str, list[str]]]:
    """Return list of (abs_source_path, per_file_args) from compile_commands."""
    with open(cc_path, "r", encoding="utf-8", errors="replace") as f:
        entries = json.load(f)
    out = []
    seen = set()
    for e in entries:
        fpath = e.get("file")
        if not fpath:
            continue
        directory = e.get("directory") or os.path.dirname(cc_path)
        if not os.path.isabs(fpath):
            fpath = os.path.normpath(os.path.join(directory, fpath))
        if fpath in seen or not os.path.isfile(fpath):
            continue
        if not fpath.endswith((".c", ".cc", ".cpp", ".cxx")):
            continue
        seen.add(fpath)
        out.append((fpath, _entry_args(e, directory)))
    return out
