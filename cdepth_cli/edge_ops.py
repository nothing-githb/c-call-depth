"""Edge removals: prune impossible caller→callee call edges from the graph.

Kept in its own module (no libclang import) so it is unit-testable on a plain
name→record dict without parsing any C. ClangGraphBuilder.build() calls
apply_edge_removals() once the graph is assembled.
"""
from __future__ import annotations

import os


def _bare(key: str) -> str:
    """Bare function name from a display key (a `name@stem` static key → name)."""
    return key.split("@", 1)[0]


def apply_edge_removals(out: dict, edge_removals: list, log=None) -> int:
    """Remove explicitly-excluded caller→callee edges from `out` IN PLACE.

    `out` maps a display key → record with at least:
        {name, file, callees[], indirect[], conditional[{targets[]}], fpSites[{candidates[]}]}
    Each removal is a dict {caller, callee, file?}. The edge is pruned wherever
    it appears — a direct call, an fp/indirect target, a conditional target, and
    the fp-site candidate list — so it leaves the graph, peak, depth, and paths
    entirely. Matching is by BARE function name (a `name@stem` static key matches
    its bare name); an optional `file` (basename of the caller's file)
    disambiguates same-named callers. Returns the number of records changed.
    """
    def emit(m):
        if log:
            log(m)

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
        matched = False
        for rec in out.values():
            if not wildcard and rec.get("name") != rc:
                continue
            if rfb and os.path.basename(rec.get("file", "")) != rfb:
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
            emit(f"edge-removal #{j} ({rc or '*'} -> {rcal}) matched no edge")
    if edge_removals:
        emit(f"applied {removed} edge removal(s)")
    return removed
