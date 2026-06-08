#!/usr/bin/env python3
"""Conditional edge-removal tests (no libclang needed).

A removal entry with a "when" condition is applied PER-ROOT during analysis:
the edge stays in the global graph (so own-peak/downDepth keep the worst case),
but a traversal drops it whenever the condition holds for that root/path. This
runs compute_analysis() directly (it imports no clang) on a tiny FunctionInfo
graph and checks that the edge is gone only from the matching root.

Graph:  root_a -> disp -> {hb (1000B), hc (20B)}
        root_b -> disp -> {hb,         hc}
Removal: disp -> hb  WHEN fromRoot == root_a.

Run: python3 test/edge-removal-conditional-test.py
"""
import os
import sys
sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
from cdepth_cli.analysis import FunctionInfo, compute_analysis

failed = 0
def check(name, cond):
    global failed
    print(("  ok  " if cond else " FAIL ") + name)
    if not cond:
        failed += 1

def build(removed):
    return {
        "root_a": FunctionInfo("root_a", "a.c", 0, ["disp"], stack_bytes=10),
        "root_b": FunctionInfo("root_b", "b.c", 0, ["disp"], stack_bytes=10),
        "disp":   FunctionInfo("disp", "d.c", 0, ["hb", "hc"], stack_bytes=10,
                               removed_callees=removed),
        "hb":     FunctionInfo("hb", "d.c", 0, [], stack_bytes=1000),
        "hc":     FunctionInfo("hc", "d.c", 0, [], stack_bytes=20),
    }

PIN = {"root_a", "root_b"}
def roots_of(res, fn):
    return set(e["root"] for e in res["byName"][fn]["perRoot"])
def peak_from(res, fn, root):
    for e in res["byName"][fn]["perRoot"]:
        if e["root"] == root:
            return e["peak"]
    return None

# --- Control: no removal -> hb reached from BOTH roots. ---
base = compute_analysis(build([]), pinned_roots=PIN, max_depth=256)
check("control: hb reached from both roots", roots_of(base, "hb") == {"root_a", "root_b"})

# --- Conditional removal: disp->hb only when fromRoot == root_a. ---
res = compute_analysis(
    build([{"callee": "hb", "cond": {"fromRoot": "root_a"}}]),
    pinned_roots=PIN, max_depth=256)

check("hb is NOT reached from root_a (edge removed there)",
      "root_a" not in roots_of(res, "hb"))
check("hb is STILL reached from root_b (condition does not hold)",
      "root_b" in roots_of(res, "hb"))
check("hc (untouched) still reached from both roots",
      roots_of(res, "hc") == {"root_a", "root_b"})
check("disp per-root peak from root_a drops below root_b (hb's 1000B excluded)",
      peak_from(res, "disp", "root_a") < peak_from(res, "disp", "root_b"))
# Global view keeps the worst case: the edge stays in callees and own-peak.
check("global: hb stays in disp.callees (graph keeps the possible edge)",
      "hb" in res["byName"]["disp"]["callees"])
check("global: disp own-peak still includes hb (root-independent worst case)",
      res["byName"]["disp"]["peak"] >= 1000)

# --- callerContains condition: drop disp->hb only on paths through root_b. ---
res2 = compute_analysis(
    build([{"callee": "hb", "cond": {"callerContains": "root_b"}}]),
    pinned_roots=PIN, max_depth=256)
check("callerContains: hb dropped on the root_b path, kept on root_a",
      roots_of(res2, "hb") == {"root_a"})

# --- "any caller": if a path comes through A, NOTHING can reach B. The edge
#     into B is dropped for ANY caller (here `mid`, which is not A itself)
#     whenever A is on the path. This is the caller-less + callerContains case. ---
def build_anyB():
    return {
        "root_a": FunctionInfo("root_a", "a.c", 0, ["A"], stack_bytes=10),
        "root_d": FunctionInfo("root_d", "d.c", 0, ["mid"], stack_bytes=10),
        "A":      FunctionInfo("A", "x.c", 0, ["mid"], stack_bytes=10),
        # mid is the actual caller of B (not A) — caller-less removal attaches the
        # rule here (and to every function); it fires when A is on the path.
        "mid":    FunctionInfo("mid", "x.c", 0, ["B"], stack_bytes=10,
                               removed_callees=[{"callee": "B", "cond": {"callerContains": "A"}}]),
        "B":      FunctionInfo("B", "x.c", 0, [], stack_bytes=1000),
    }
res3 = compute_analysis(build_anyB(), pinned_roots={"root_a", "root_d"}, max_depth=256)
check("any-caller: B unreachable from root_a (the path passes through A)",
      "root_a" not in roots_of(res3, "B"))
check("any-caller: B still reachable from root_d (no A on the path)",
      "root_d" in roots_of(res3, "B"))
check("any-caller: intermediate mid is still reached from both roots",
      roots_of(res3, "mid") == {"root_a", "root_d"})

print("\nEDGE-REMOVAL-CONDITIONAL: PASS - per-root conditional removal works." if failed == 0
      else f"\nEDGE-REMOVAL-CONDITIONAL: FAIL - {failed} check(s) failed.")
sys.exit(0 if failed == 0 else 1)
