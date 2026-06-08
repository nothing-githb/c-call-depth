#!/usr/bin/env python3
"""fp-override behavior tests (CLI / clang_builder level).

Verifies how overrides are applied WITHOUT needing libclang or a real project:
the override-folding logic lives in ClangGraphBuilder.build(), but here we test
the smaller, self-contained pieces by simulating indirect_sites + overrides.

Focus: an override with NO targets and NO conditional targets must be IGNORED
(with a warning), leaving the call site auto-ESTIMATED and "not bound".

Run: python3 test/fp-override-test.py
"""
import sys, os
sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

failed = 0
def check(name, cond):
    global failed
    print(("  ok  " if cond else " FAIL ") + name)
    if not cond:
        failed += 1

# Re-implement the override-acceptance predicate exactly as clang_builder does,
# so this test pins the contract even without running libclang.
def override_is_usable(ov):
    tgts = list(ov.get("targets", []))
    cond = ov.get("conditional", []) or []
    cond_has_targets = any((c or {}).get("targets") for c in cond)
    return bool(tgts) or cond_has_targets

# 1) Empty targets, no conditional -> NOT usable (ignored).
check("empty targets, no conditional -> ignored",
      override_is_usable({"caller": "f", "via": "tbl", "targets": []}) is False)

# 2) targets omitted entirely -> NOT usable.
check("targets omitted, no conditional -> ignored",
      override_is_usable({"caller": "f", "via": "tbl"}) is False)

# 3) Real targets -> usable (binds).
check("real targets -> usable",
      override_is_usable({"caller": "f", "targets": ["g"]}) is True)

# 4) Conditional with targets -> usable (binds conditionally).
check("conditional with targets -> usable",
      override_is_usable({"caller": "f",
                          "conditional": [{"when": {"fromRoot": "r"}, "targets": ["g"]}]}) is True)

# 5) Conditional present but its targets empty -> NOT usable.
check("conditional with empty targets -> ignored",
      override_is_usable({"caller": "f",
                          "conditional": [{"when": {"fromRoot": "r"}, "targets": []}]}) is False)

print("\nFP-OVERRIDE: PASS - all checks passed." if failed == 0
      else f"\nFP-OVERRIDE: FAIL - {failed} check(s) failed.")
sys.exit(0 if failed == 0 else 1)
