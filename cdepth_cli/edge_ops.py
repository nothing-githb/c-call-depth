"""Edge removals: prune impossible caller→callee call edges from the graph.

Kept in its own module (no libclang import) so it is unit-testable on a plain
name→record dict without parsing any C. ClangGraphBuilder.build() calls
apply_edge_removals() once the graph is assembled, so removals act on the SINGLE
shared call graph — every downstream view (own peak, downDepth, per-root, the
call-graph webview, Calls-into/Callers paths) reads the pruned graph and reflects
them uniformly.
"""
from __future__ import annotations

import os


def _bare(key: str) -> str:
    """Bare function name from a display key (a `name@stem` static key → name)."""
    return key.split("@", 1)[0]


def _build_reachability(out: dict):
    """Return reaches(src, dst): True if dst == src or dst is reachable from src
    by following callees in the (pre-removal) graph. Keys are BARE names. Used to
    evaluate conditional removals statically — `callerContains C` for an edge
    whose caller is X means "C reaches X" (C is a transitive caller of X)."""
    adj: dict[str, set] = {}
    for rec in out.values():
        s = adj.setdefault(rec.get("name"), set())
        for c in rec.get("callees", []):
            s.add(_bare(c))
    cache: dict[str, set] = {}

    def reachable_from(f: str) -> set:
        if f in cache:
            return cache[f]
        seen: set = set()
        stack = [f]
        while stack:
            n = stack.pop()
            for c in adj.get(n, ()):
                if c not in seen:
                    seen.add(c)
                    stack.append(c)
        cache[f] = seen
        return seen

    def reaches(src: str, dst: str) -> bool:
        return dst == src or dst in reachable_from(src)

    return reaches


def _eval_when(cond, caller_bare: str, reaches) -> bool:
    """Evaluate a removal condition STATICALLY for an edge whose caller is
    `caller_bare`. callerContains F / fromRoot F  →  F reaches the caller (F is a
    transitive caller). Combined with all / any / not. No condition (None) → True."""
    if not isinstance(cond, dict):
        return True
    if "callerContains" in cond:
        return reaches(str(cond["callerContains"]), caller_bare)
    if "fromRoot" in cond:
        # No single root in the global graph; treat "from root R" as "R reaches
        # the caller" (R is an ancestor on some path), the static analogue.
        return reaches(str(cond["fromRoot"]), caller_bare)
    if "all" in cond:
        return all(_eval_when(s, caller_bare, reaches) for s in cond["all"])
    if "any" in cond:
        return any(_eval_when(s, caller_bare, reaches) for s in cond["any"])
    if "not" in cond:
        return not _eval_when(cond["not"], caller_bare, reaches)
    return True


def apply_edge_removals(out: dict, edge_removals: list, log=None) -> int:
    """Remove explicitly-excluded caller→callee edges from `out` IN PLACE.

    `out` maps a display key → record with at least:
        {name, file, callees[], indirect[], conditional[{targets[]}], fpSites[{candidates[]}]}
    Each removal is a dict {caller?, callee, file?, when?}. The edge is pruned
    wherever it appears — a direct call, an fp/indirect target, a conditional
    target, and the fp-site candidate list — so it leaves the graph, peak, depth,
    and paths entirely.

    Matching: by BARE function name (a `name@stem` static key matches its bare
    name). `caller` is OPTIONAL (omit or "*" = any caller of `callee`); an
    optional `file` (basename of the caller's file) disambiguates same-named
    callers. An optional `when` makes the removal CONDITIONAL and evaluated
    statically against the graph (callerContains / fromRoot / all / any / not):
    the edge is removed only for callers that satisfy the condition. Returns the
    number of records changed.
    """
    def emit(m):
        if log:
            log(m)

    reaches = None  # lazily built only if a conditional removal is present

    removed = 0
    for j, rm in enumerate(edge_removals or []):
        rcal = str(rm.get("callee", "")) if isinstance(rm, dict) else ""
        if not rcal:
            emit(f"edge-removal #{j} ignored (needs a callee)")
            continue
        # caller is OPTIONAL: omitted or "*" means "any caller of `callee`".
        rc = str(rm.get("caller", ""))
        wildcard = rc == "" or rc == "*"
        rfb = os.path.basename(str(rm.get("file", "")))
        cond = rm.get("when") if isinstance(rm, dict) else None
        if cond is not None and reaches is None:
            reaches = _build_reachability(out)
        matched = False
        for rec in out.values():
            if not wildcard and rec.get("name") != rc:
                continue
            if rfb and os.path.basename(rec.get("file", "")) != rfb:
                continue
            if cond is not None and not _eval_when(cond, rec.get("name"), reaches):
                continue

            def keep(c):
                return _bare(c) != rcal and c != rcal

            before = len(rec.get("callees", [])) + len(rec.get("indirect", []))
            rec["callees"] = [c for c in rec.get("callees", []) if keep(c)]
            rec["indirect"] = [c for c in rec.get("indirect", []) if keep(c)]
            for ce in rec.get("conditional", []) or []:
                ce["targets"] = [t for t in ce.get("targets", []) if keep(t)]
            for s in rec.get("fpSites", []) or []:
                if s.get("candidates"):
                    s["candidates"] = [t for t in s["candidates"] if keep(t)]
            if before != len(rec["callees"]) + len(rec["indirect"]):
                removed += 1
                matched = True
        if not matched:
            cw = " when …" if cond is not None else ""
            emit(f"edge-removal #{j} ({rc or '*'} -> {rcal}{cw}) matched no edge")
    if edge_removals:
        emit(f"applied {removed} edge removal(s)")
    return removed
