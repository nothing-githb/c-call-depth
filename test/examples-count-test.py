#!/usr/bin/env python3
"""Verifies the big-workspace contains the expected recursion and unbound-fp
examples, and that the analyzer detects them.

Usage: python3 test/examples-count-test.py <analysis.json>
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

    recursive = [n for n, v in bn.items() if v.get("recursive") is True]
    rec_self = [n for n in recursive if n.startswith("rec_self_")]
    rec_pingpong = [n for n in recursive if n.startswith("rec_ping_") or n.startswith("rec_pong_")]
    rec_cyc = [n for n in recursive if n.startswith("rec_cyc_")]
    generated_rec = [n for n in recursive
                     if n.startswith("rec_self_") or n.startswith("rec_ping_")
                     or n.startswith("rec_pong_") or n.startswith("rec_cyc_")]

    check("50 generated recursive functions detected", len(generated_rec) == 50,
          f"got {len(generated_rec)} ({len(rec_self)} self, {len(rec_pingpong)} ping/pong, {len(rec_cyc)} cyc)")
    check("direct self-recursion detected (>=20)", len(rec_self) >= 20, f"got {len(rec_self)}")
    check("mutual recursion detected (>=20 ping/pong)", len(rec_pingpong) >= 20, f"got {len(rec_pingpong)}")
    check("3-cycle recursion detected (>=6 cyc)", len(rec_cyc) >= 6, f"got {len(rec_cyc)}")

    # Unbound fp: a function with at least one fpSite not overridden.
    def is_unbound(v):
        return any(s.get("overridden") is not True for s in (v.get("fpSites") or []))
    unbound = [n for n, v in bn.items() if is_unbound(v)]
    many_fp = [n for n in unbound if n.startswith("many_fp_")]
    check("50 generated unbound-fp dispatchers detected", len(many_fp) == 50, f"got {len(many_fp)}")

    # Each many_fp_* must be marked NOT fpVerified (estimate, not bound).
    not_verified = [n for n in many_fp if bn[n].get("fpVerified") is not True]
    check("all many_fp_* are unverified (estimated, not bound)", len(not_verified) == 50,
          f"got {len(not_verified)} unverified")

    # Each many_fp_* has a positive peak (its estimate rests on a leaf frame).
    pos_peak = [n for n in many_fp if (bn[n].get("peak") or 0) > 0]
    check("all many_fp_* have a positive estimated peak", len(pos_peak) == 50, f"got {len(pos_peak)}")

    # Recursive functions are flagged and reachable from recur_root.
    check("recur_root present", "recur_root" in bn)
    check("manyfp_root present", "manyfp_root" in bn)

    # Long cycle: a single 100-hop recursion loop lc_00..99, all flagged
    # recursive (certain, not via fp). This exercises the side panel's
    # shortest-cycle BFS on real data (a loop far longer than the DFS depth cap).
    lc = [n for n in bn if n.startswith("lc_")]
    lc_rec = [n for n in lc if bn[n].get("recursive") is True]
    check("100-hop long cycle present (lc_00..99)", len(lc) == 100, f"got {len(lc)}")
    check("all 100 long-cycle functions are recursive", len(lc_rec) == 100, f"got {len(lc_rec)}")
    check("long cycle is certain recursion (not via fp)",
          all(bn[n].get("recursiveViaFp") is not True for n in lc), "some marked viaFp")
    check("long-cycle peak is bounded and finite",
          isinstance(bn.get("lc_00", {}).get("peak"), int) and bn["lc_00"].get("peak") > 0)
    check("longcycle_root present", "longcycle_root" in bn)

    print(f"\nEXAMPLES-COUNT: {'PASS' if failed == 0 else 'FAIL'} — "
          + ("50 recursion + 50 unbound-fp examples present and detected."
             if failed == 0 else f"{failed} check(s) failed."))
    sys.exit(0 if failed == 0 else 1)

if __name__ == "__main__":
    main()
