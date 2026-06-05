#!/usr/bin/env python3
"""Pinned-root policy test.

Policy: a function whose DECLARATION file matches a root pattern is ALWAYS a
pinned root — even if it also has callers. Pinning marks it as an entry point
(it gets its own per-root analysis) but must NOT cut the call edge: any caller's
downward peak still includes the pinned function's subtree (peak is
downward-only and root-independent).

This guards against re-introducing a "skip pattern matches that have callers"
filter, which made sibling functions in the same public header inconsistently
pinned.

Usage: python3 test/pinned-root-test.py <analysis.json>
  (analysis must be produced with --root-pattern '**/public/**' on the
   big-workspace, which has manyfp/public/manyfp.h declaring many_fp_00..49,
   where many_fp_00 and many_fp_49 ARE called by manyfp_root.)
"""
import json, sys

def main():
    data = json.load(open(sys.argv[1]))
    bn = data["byName"]
    failed = 0
    def check(name, cond, extra=""):
        nonlocal failed
        print(("  ok  " if cond else " FAIL ") + name + ("" if cond else "  " + extra))
        if not cond:
            failed += 1

    # All 50 many_fp_* are declared in manyfp/public/manyfp.h → all pinned.
    many = [n for n in bn if n.startswith("many_fp_")]
    pinned_many = [n for n in many if bn[n].get("isPinnedRoot") is True]
    check("all 50 many_fp_* are pinned roots (pattern wins over having callers)",
          len(many) == 50 and len(pinned_many) == 50,
          f"{len(pinned_many)}/{len(many)} pinned")

    # many_fp_00 and many_fp_49 specifically HAVE a caller (manyfp_root) yet are pinned.
    for n in ["many_fp_00", "many_fp_49"]:
        check(f"{n} is pinned despite having a caller",
              bn.get(n, {}).get("isPinnedRoot") is True)

    # The caller's peak must STILL include the pinned callee's subtree (edge not cut).
    mr = bn.get("manyfp_root", {})
    frame_mr = mr.get("stackBytes") or 0
    peak_mr = mr.get("peak") or 0
    callee_peaks = [bn[c].get("peak") or 0 for c in (mr.get("callees") or []) if c in bn]
    expected = frame_mr + (max(callee_peaks) if callee_peaks else 0)
    check("manyfp_root peak still includes its pinned callees (edge not cut)",
          peak_mr == expected, f"peak={peak_mr} expected={expected}")
    check("manyfp_root peak is strictly greater than its own frame (descends in)",
          peak_mr > frame_mr, f"peak={peak_mr} frame={frame_mr}")

    # A pinned-with-caller function carries BOTH per-root entries: itself (as an
    # entry point) and its caller (as a reachable path).
    pr = bn.get("many_fp_00", {}).get("perRoot", [])
    roots = {e.get("root") for e in pr}
    check("many_fp_00 has its own per-root entry (entry point)", "many_fp_00" in roots,
          f"roots={sorted(roots)}")
    check("many_fp_00 also appears under its caller's root", "manyfp_root" in roots,
          f"roots={sorted(roots)}")

    # isAutoRoot and isPinnedRoot are mutually exclusive (pinned takes precedence).
    both = [n for n in bn if bn[n].get("isPinnedRoot") and bn[n].get("isAutoRoot")]
    check("no function is both pinned and auto root", len(both) == 0, f"{both[:5]}")

    print(f"\nPINNED-ROOT: {'PASS' if failed == 0 else 'FAIL'} — "
          + ("pattern-matched functions are always pinned and stay in peak calc."
             if failed == 0 else f"{failed} check(s) failed."))
    sys.exit(0 if failed == 0 else 1)

if __name__ == "__main__":
    main()
