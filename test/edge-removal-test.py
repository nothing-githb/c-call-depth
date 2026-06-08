#!/usr/bin/env python3
"""edge-removal behavior tests (no libclang needed).

apply_edge_removals() lives in cdepth_cli/edge_ops.py (no clang import), so we
test the real function on a plain name->record graph. It must prune a
caller->callee edge wherever it appears (direct, fp/indirect, conditional,
fp-site candidates), scope to the matching caller (and optional file), match a
`name@stem` static key by bare name, and report no-match.

Run: python3 test/edge-removal-test.py
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

def mk():
    # A -> {B (direct), C (direct+fp), D (fp only)}; A also has a conditional edge
    # to C and an fp-site listing C as a candidate. B (a different caller) -> C.
    return {
        "A": {"name": "A", "file": "a.c",
              "callees": ["B", "C", "D"], "indirect": ["C", "D"],
              "conditional": [{"targets": ["C"], "cond": {}}],
              "fpSites": [{"line": 5, "candidates": ["C", "D"]}]},
        "B": {"name": "B", "file": "b.c", "callees": ["C"], "indirect": [],
              "conditional": [], "fpSites": []},
        "C": {"name": "C", "file": "c.c", "callees": [], "indirect": [],
              "conditional": [], "fpSites": []},
        "D": {"name": "D", "file": "d.c", "callees": [], "indirect": [],
              "conditional": [], "fpSites": []},
    }

# 1) Remove A->C: gone from callees, indirect, conditional, fp-site candidates.
g = mk()
n = apply_edge_removals(g, [{"caller": "A", "callee": "C"}])
check("A->C removed from callees", "C" not in g["A"]["callees"])
check("A->C removed from indirect (fp)", "C" not in g["A"]["indirect"])
check("A->C removed from conditional targets", g["A"]["conditional"][0]["targets"] == [])
check("A->C removed from fp-site candidates", g["A"]["fpSites"][0]["candidates"] == ["D"])
check("removal is scoped: B->C is untouched", g["B"]["callees"] == ["C"])
check("other A edges kept (B, D)", g["A"]["callees"] == ["B", "D"])
check("returns 1 changed record", n == 1)

# 2) Remove a fp-only edge A->D.
g = mk()
apply_edge_removals(g, [{"caller": "A", "callee": "D"}])
check("A->D removed from callees and indirect",
      "D" not in g["A"]["callees"] and "D" not in g["A"]["indirect"])

# 3) `name@stem` static key matches by bare name.
g2 = {"A@x": {"name": "A", "file": "x.c", "callees": ["util@x", "B"], "indirect": [],
              "conditional": [], "fpSites": []}}
apply_edge_removals(g2, [{"caller": "A", "callee": "util"}])
check("static display key util@x matched by bare name 'util'",
      g2["A@x"]["callees"] == ["B"])

# 4) file scoping: only the caller in the named file is pruned.
g3 = {
    "A#1": {"name": "A", "file": "one.c", "callees": ["C"], "indirect": [], "conditional": [], "fpSites": []},
    "A#2": {"name": "A", "file": "two.c", "callees": ["C"], "indirect": [], "conditional": [], "fpSites": []},
}
apply_edge_removals(g3, [{"caller": "A", "callee": "C", "file": "one.c"}])
check("file-scoped removal hits one.c", g3["A#1"]["callees"] == [])
check("file-scoped removal spares two.c", g3["A#2"]["callees"] == ["C"])

# 5) No-match and malformed entries are reported, not fatal.
logs = []
g = mk()
apply_edge_removals(g, [{"caller": "A", "callee": "ZZZ"},
                        {"caller": "A"}], log=lambda m: logs.append(m))
check("no-match edge is logged", any("matched no edge" in m for m in logs))
check("malformed removal (no callee) is logged + ignored",
      any("ignored" in m for m in logs))
check("graph unchanged by no-op removals", g["A"]["callees"] == ["B", "C", "D"])

print("\nEDGE-REMOVAL: PASS - edges pruned everywhere, scoped correctly." if failed == 0
      else f"\nEDGE-REMOVAL: FAIL - {failed} check(s) failed.")
sys.exit(0 if failed == 0 else 1)
