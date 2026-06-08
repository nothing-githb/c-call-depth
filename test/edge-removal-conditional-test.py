#!/usr/bin/env python3
"""Conditional (global) edge-removal tests (no libclang needed).

A removal entry with a "when" condition is now applied to the SINGLE shared graph
in apply_edge_removals() (cdepth_cli/edge_ops.py), evaluated STATICALLY against
the graph: callerContains C means "C reaches the edge's caller" (transitive). So
the pruned edge leaves the one graph and every view (graph, own-peak, downDepth,
per-root, Calls-into) reflects it. We test the real function on a plain
name->record dict.

Run: python3 test/edge-removal-conditional-test.py
"""
import os
import sys
sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
from cdepth_cli.edge_ops import apply_edge_removals

failed = 0
def check(name, cond):
    global failed
    print(("  ok  " if cond else " FAIL ") + name)
    if not cond:
        failed += 1

def rec(name, callees, file="x.c"):
    return {"name": name, "file": file, "callees": list(callees),
            "indirect": [], "conditional": [], "fpSites": []}

def callees(g, n):
    return g[n]["callees"]

# Graph:  C -> A -> B ;  D -> A  (A has two callers: C and D)
def g_basic():
    return {
        "C": rec("C", ["A"]),
        "D": rec("D", ["A"]),
        "A": rec("A", ["B"]),
        "B": rec("B", []),
    }

# 1) {caller:A, callee:B, when:callerContains C}: C reaches A -> remove A->B GLOBALLY.
g = g_basic()
apply_edge_removals(g, [{"caller": "A", "callee": "B", "when": {"callerContains": "C"}}])
check("A->B removed from the global graph (C reaches A)", "B" not in callees(g, "A"))

# 2) Condition false (Z does not reach A) -> A->B kept.
g = g_basic()
apply_edge_removals(g, [{"caller": "A", "callee": "B", "when": {"callerContains": "Z"}}])
check("A->B kept when condition is false (Z does not reach A)", "B" in callees(g, "A"))

# 3) Transitive: E -> M -> F -> B ; remove F->B when callerContains E (E reaches F via M).
def g_deep():
    return {
        "E": rec("E", ["M"]),
        "M": rec("M", ["F"]),
        "F": rec("F", ["B"]),
        "B": rec("B", []),
    }
g = g_deep()
apply_edge_removals(g, [{"caller": "F", "callee": "B", "when": {"callerContains": "E"}}])
check("transitive: F->B removed (E reaches F through M)", "B" not in callees(g, "F"))

# 4) caller omitted = any caller of B, each evaluated independently.
#    C -> A -> B  and  G -> B  (G NOT reachable from C).
def g_fan():
    return {
        "C": rec("C", ["A"]),
        "A": rec("A", ["B"]),
        "G": rec("G", ["B"]),
        "B": rec("B", []),
    }
g = g_fan()
apply_edge_removals(g, [{"callee": "B", "when": {"callerContains": "C"}}])
check("fan-out: A->B removed (C reaches A)", "B" not in callees(g, "A"))
check("fan-out: G->B kept (C does not reach G)", "B" in callees(g, "G"))

# 5) callerContains of the caller itself holds (self is its own ancestor here).
g = g_basic()
apply_edge_removals(g, [{"caller": "A", "callee": "B", "when": {"callerContains": "A"}}])
check("callerContains of the caller itself => removed", "B" not in callees(g, "A"))

# 6) any / not combinators.
g = g_basic()
apply_edge_removals(g, [{"caller": "A", "callee": "B",
                         "when": {"any": [{"callerContains": "Z"}, {"callerContains": "C"}]}}])
check("any: removed because one branch (C) holds", "B" not in callees(g, "A"))
g = g_basic()
apply_edge_removals(g, [{"caller": "A", "callee": "B", "when": {"not": {"callerContains": "Z"}}}])
check("not: removed because Z does NOT reach A", "B" not in callees(g, "A"))
g = g_basic()
apply_edge_removals(g, [{"caller": "A", "callee": "B", "when": {"not": {"callerContains": "C"}}}])
check("not: kept because C DOES reach A", "B" in callees(g, "A"))

# 7) Global: the edge is gone from `callees` itself, so EVERY downstream view
#    (own-peak, downDepth, per-root, the webview graph) sees the pruned graph.
g = g_basic()
apply_edge_removals(g, [{"caller": "A", "callee": "B", "when": {"callerContains": "C"}}])
check("global: removal mutates the shared callees (all views consistent)",
      callees(g, "A") == [] and "B" in g)

# 8) Unconditional removal still works (no `when`).
g = g_basic()
apply_edge_removals(g, [{"caller": "A", "callee": "B"}])
check("unconditional removal still prunes A->B", "B" not in callees(g, "A"))

print("\nEDGE-REMOVAL-CONDITIONAL: PASS - global conditional removal works." if failed == 0
      else f"\nEDGE-REMOVAL-CONDITIONAL: FAIL - {failed} check(s) failed.")
sys.exit(0 if failed == 0 else 1)
