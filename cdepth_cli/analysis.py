"""Static stack analysis: depth, downward peak, per-root entries.

Ported from the TypeScript callGraph module, keeping the same semantics that
were settled on during development:

  * Peak is DOWNWARD-ONLY: peak(f) = frame(f) + max over callees c of peak(c).
    It does NOT include caller frames, so a function has the same peak from
    every root. Recursion (a cycle) marks the peak as a lower bound ("bounded"
    = the '+' suffix) since the true worst case is unbounded.
  * Depth is per-root: the longest call chain length from a given root to the
    function (root itself = depth 1). Depth varies by entry point; peak does
    not.
  * Roots: pinned roots (from glob patterns over file paths) plus "auto" roots
    (functions with no caller that aren't pinned). Each root is an independent
    analysis origin.

Cycles are collapsed with Tarjan's SCC so recursion doesn't loop forever; any
function in a non-trivial SCC is flagged recursive and its peak is bounded.
"""

from __future__ import annotations

import sys
from typing import Optional

sys.setrecursionlimit(1 << 20)


class FunctionInfo:
    __slots__ = ("name", "file", "line", "callees", "stack_bytes",
                 "stack_qualifier", "indirect_callees", "decl_file",
                 "fp_verified", "conditional_callees")

    def __init__(self, name, file, line, callees, stack_bytes=None,
                 stack_qualifier="", indirect_callees=None, decl_file=None,
                 fp_verified=False, conditional_callees=None):
        self.name = name
        self.file = file
        self.line = line
        self.callees = callees
        self.stack_bytes = stack_bytes
        self.stack_qualifier = stack_qualifier
        # Subset of `callees` reached only through a function-pointer table
        # (over-approximated). Recursion that relies solely on these edges is
        # "possible" rather than "certain".
        self.indirect_callees = indirect_callees or []
        # File where the function is *declared* (its prototype) — a header when
        # one exists, else the definition file. Root patterns match on this.
        self.decl_file = decl_file or file
        # True when this function's indirect call site(s) were manually verified
        # via a fp-override, so its fp edges are exact, not over-approximated.
        self.fp_verified = fp_verified
        # Conditional fp edges: list of {"targets":[names], "cond":<dict>}.
        # The targets are also present in `callees` (so they show in the graph
        # and recursion as possible edges), but per-root peak only follows them
        # when the condition holds for that root/path.
        self.conditional_callees = conditional_callees or []


def _tarjan_scc(names: list[str], callees: dict[str, list[str]]) -> dict[str, int]:
    """Return name → scc id. Iterative Tarjan to avoid deep recursion."""
    index = {}
    low = {}
    on_stack = {}
    stack = []
    scc_id = {}
    counter = [0]
    cur_scc = [0]

    for root in names:
        if root in index:
            continue
        work = [(root, 0)]
        while work:
            node, pi = work[-1]
            if pi == 0:
                index[node] = low[node] = counter[0]
                counter[0] += 1
                stack.append(node)
                on_stack[node] = True
            recurse = False
            succs = callees.get(node, [])
            i = pi
            while i < len(succs):
                w = succs[i]
                if w not in callees and w not in index:
                    i += 1
                    continue
                if w not in index:
                    work[-1] = (node, i + 1)
                    work.append((w, 0))
                    recurse = True
                    break
                elif on_stack.get(w):
                    low[node] = min(low[node], index[w])
                i += 1
            if recurse:
                continue
            # done with node's successors
            work.pop()
            if work:
                parent = work[-1][0]
                low[parent] = min(low[parent], low[node])
            if low[node] == index[node]:
                while True:
                    w = stack.pop()
                    on_stack[w] = False
                    scc_id[w] = cur_scc[0]
                    if w == node:
                        break
                cur_scc[0] += 1
    return scc_id


def compute_analysis(functions: dict[str, FunctionInfo],
                     pinned_roots: Optional[set[str]] = None,
                     max_depth: int = 64) -> dict:
    """Return a result dict ready to serialize:
       { "byName": { name: {...} }, "roots": [...] }"""
    pinned_roots = pinned_roots or set()
    names = list(functions.keys())
    callees = {n: [c for c in functions[n].callees if c in functions] for n in names}

    # Callers (reverse edges).
    callers: dict[str, set[str]] = {n: set() for n in names}
    for n in names:
        for c in callees[n]:
            callers[c].add(n)

    # SCC for recursion detection.
    scc = _tarjan_scc(names, callees)
    scc_size: dict[int, int] = {}
    for n in names:
        scc_size[scc[n]] = scc_size.get(scc[n], 0) + 1
    # Self-loop also counts as recursive.
    recursive = set()
    for n in names:
        if scc_size[scc[n]] > 1 or n in callees[n]:
            recursive.add(n)

    # Distinguish CERTAIN recursion (a direct call edge participates in the
    # cycle) from POSSIBLE recursion (the cycle relies only on function-pointer
    # edges, which are over-approximated and may not represent a real call).
    # For each recursive function, look at the edges that stay inside its SCC:
    # if at least one such edge is a *direct* (non-fp) call, recursion is
    # certain; if every in-SCC edge is fp-derived, it's only possible — UNLESS
    # the function's fp call site was manually verified, in which case its fp
    # edges are treated as exact (certain), not over-approximated.
    indirect_set = {n: (set() if functions[n].fp_verified
                        else set(functions[n].indirect_callees)) for n in names}
    recursive_via_fp = set()  # recursive, but only through fp edges
    for n in recursive:
        my_scc = scc[n]
        in_scc_edges = [c for c in callees[n] if scc[c] == my_scc]
        # A self-loop with n in its own direct (non-fp) callees is certain.
        direct_in_scc = [c for c in in_scc_edges if c not in indirect_set[n]]
        if not direct_in_scc:
            recursive_via_fp.add(n)

    # Downward peak via memoized DFS over the SCC-collapsed DAG.
    # peak(n) = frame(n) + max(peak(c) for c in callees), with cycle guard.
    peak_cache: dict[str, tuple[int, bool]] = {}

    def frame(n: str) -> int:
        b = functions[n].stack_bytes
        return b if b is not None else 0

    # Conditional fp edges: cond_map[n][target] = condition dict. These targets
    # are also in callees[n] (possible edges), but a per-root traversal only
    # follows them when the condition holds for that (root, path).
    cond_map: dict[str, dict[str, dict]] = {n: {} for n in names}
    cond_funcs: set[str] = set()  # functions named in callerContains conditions

    def _collect_cond_funcs(cond):
        if not isinstance(cond, dict):
            return
        if "callerContains" in cond:
            cond_funcs.add(str(cond["callerContains"]))
        for key in ("all", "any"):
            for sub in cond.get(key, []) or []:
                _collect_cond_funcs(sub)
        if "not" in cond:
            _collect_cond_funcs(cond["not"])

    for n in names:
        for ce in functions[n].conditional_callees:
            cond = ce.get("cond")
            for t in ce.get("targets", []):
                if t in functions:
                    cond_map[n][t] = cond
            _collect_cond_funcs(cond)
    has_conditions = any(cond_map[n] for n in names)
    # Cap distinct callerContains functions so the path mask stays small
    # (state space is N·2^k). Beyond the cap, treat callerContains as always
    # true (safe over-approximation).
    COND_FUNC_CAP = 12
    cond_funcs_list = sorted(cond_funcs)[:COND_FUNC_CAP]
    cond_func_bit = {f: i for i, f in enumerate(cond_funcs_list)}

    def eval_cond(cond, root: str, mask: int) -> bool:
        """Evaluate a condition given the traversal root and the bitmask of
        callerContains-functions present on the current path (incl. the caller).
        Unknown/overflow callerContains functions evaluate True (over-approx)."""
        if not isinstance(cond, dict):
            return True
        if "fromRoot" in cond:
            return root == str(cond["fromRoot"])
        if "callerContains" in cond:
            bit = cond_func_bit.get(str(cond["callerContains"]))
            if bit is None:
                return True
            return bool(mask & (1 << bit))
        if "all" in cond:
            return all(eval_cond(s, root, mask) for s in cond["all"])
        if "any" in cond:
            return any(eval_cond(s, root, mask) for s in cond["any"])
        if "not" in cond:
            return not eval_cond(cond["not"], root, mask)
        return True

    def bit_of(n: str) -> int:
        b = cond_func_bit.get(n)
        return (1 << b) if b is not None else 0

    def active_callees(n: str, root: str, mask: int):
        """Callees active under (root, mask): static edges plus conditional
        edges whose condition holds. mask must already include n's own bit."""
        cm = cond_map[n]
        if not cm:
            return callees[n]
        return [c for c in callees[n]
                if c not in cm or eval_cond(cm[c], root, mask)]

    def peak(n: str, visiting: set[str]) -> tuple[int, bool]:
        if n in peak_cache:
            return peak_cache[n]
        if n in visiting:
            # Cycle: return own frame, mark bounded (lower bound).
            return frame(n), True
        visiting.add(n)
        best = 0
        bounded = False
        for c in callees[n]:
            cb, cbd = peak(c, visiting)
            if cb > best:
                best = cb
            bounded = bounded or cbd
        visiting.discard(n)
        # If n is recursive, its own subtree is a lower bound.
        total = frame(n) + best
        result = (total, bounded or (n in recursive))
        # Only cache when not inside an active cycle for correctness.
        peak_cache[n] = result
        return result

    # Downward DEPTH: the longest call chain starting at n and going DOWN
    # (n itself = depth 1). This is "how deep does this function reach",
    # independent of any root above it. Cycles cap the chain (bounded).
    down_depth_cache: dict[str, tuple[int, bool]] = {}

    def down_depth(n: str, visiting: set[str]) -> tuple[int, bool]:
        if n in down_depth_cache:
            return down_depth_cache[n]
        if n in visiting:
            return 1, True  # cycle: count n once, mark bounded
        visiting.add(n)
        best = 0
        bounded = False
        for c in callees[n]:
            cd, cbd = down_depth(c, visiting)
            if cd > best:
                best = cd
            bounded = bounded or cbd
        visiting.discard(n)
        result = (1 + best, bounded or (n in recursive))
        down_depth_cache[n] = result
        return result

    # Determine roots: pinned ∪ auto (caller-less, non-pinned).
    auto_roots = set(n for n in names if not callers[n] and n not in pinned_roots)
    use_pinned = len(pinned_roots) > 0
    if use_pinned:
        all_roots = set(pinned_roots) | auto_roots
    else:
        # Legacy: every caller-less function is a root.
        all_roots = set(n for n in names if not callers[n])
        if not all_roots:  # fully cyclic; pick everything as potential roots
            all_roots = set(names)

    # Per-root depth + entry stack: from each root, the longest path length
    # AND the heaviest cumulative frame sum on a path root→…→n (the "entry
    # stack" reaching n from this root). per_root[name] = list of
    # {root, depth, entry, peak}.
    per_root: dict[str, list[dict]] = {n: [] for n in names}

    # Path-sensitive downward peak honoring conditional edges. Context is
    # (root, mask) where mask = callerContains-funcs present on the path INCL n.
    # Memoized per (n, mask) within a root traversal. Only used when there are
    # conditions; otherwise the plain peak() above is reused (root-independent).
    def make_dpeak(root):
        memo: dict[tuple, tuple[int, bool]] = {}

        def dpeak(n, mask, visiting):
            keym = (n, mask)
            if keym in memo:
                return memo[keym]
            if n in visiting:
                return frame(n), True
            visiting.add(n)
            best, bnd = 0, False
            for c in active_callees(n, root, mask):
                cb, cbd = dpeak(c, mask | bit_of(c), visiting)
                if cb > best:
                    best = cb
                bnd = bnd or cbd
            visiting.discard(n)
            res = (frame(n) + best, bnd or (n in recursive))
            memo[keym] = res
            return res
        return dpeak

    for root in all_roots:
        if root not in functions:
            continue
        best_depth: dict[str, int] = {root: 1}
        best_entry: dict[str, int] = {root: frame(root)}
        # Per-root peak through each node: heaviest full chain root→…→n→…→leaf
        # using only condition-valid edges. peak_through[n] = (value, bounded).
        peak_through: dict[str, tuple[int, bool]] = {}

        if not has_conditions:
            # Fast path (no conditional edges): longest path / entry stack only;
            # the per-root peak is entry + root-independent downward peak.
            stack = [(root, 1, frame(root), frozenset([root]))]
            while stack:
                node, d, es, on_path = stack.pop()
                for c in callees[node]:
                    if c in on_path:
                        continue
                    nd = d + 1
                    if nd > max_depth + 1:
                        continue
                    nes = es + frame(c)
                    improved = False
                    if c not in best_depth or nd > best_depth[c]:
                        best_depth[c] = nd; improved = True
                    if c not in best_entry or nes > best_entry[c]:
                        best_entry[c] = nes; improved = True
                    if improved:
                        stack.append((c, nd, nes, on_path | {c}))
            for n, d in best_depth.items():
                fr = frame(n)
                pk, bnd = peak(n, set())
                per_root[n].append({"root": root, "depth": d,
                                    "entry": best_entry.get(n, fr),
                                    "peak": best_entry.get(n, fr) + pk - fr,
                                    "peakBounded": bnd})
            continue

        # Conditional path: walk paths honoring conditions; at each node
        # occurrence, peak-through = entry stack to n + dpeak(n, mask) − frame(n).
        dpeak = make_dpeak(root)
        budget = [200000]
        rbit = bit_of(root)
        # state: (node, depth, entry_stack, mask, on_path); relax by (node,mask).
        seen_state: dict[tuple, int] = {}  # (node, mask) → best entry stack
        stack = [(root, 1, frame(root), rbit, frozenset([root]))]
        while stack:
            if budget[0] <= 0:
                break
            budget[0] -= 1
            node, d, es, mask, on_path = stack.pop()
            # Record reach + depth + peak-through for this occurrence.
            if node not in best_depth or d > best_depth[node]:
                best_depth[node] = d
            fr = frame(node)
            dpk, dbnd = dpeak(node, mask, set())
            pt = es + dpk - fr
            prev = peak_through.get(node)
            if prev is None or pt > prev[0]:
                peak_through[node] = (pt, dbnd)
            for c in active_callees(node, root, mask):
                if c in on_path:
                    continue
                nd = d + 1
                if nd > max_depth + 1:
                    continue
                nmask = mask | bit_of(c)
                nes = es + frame(c)
                st = (c, nmask)
                if st in seen_state and seen_state[st] >= nes and nd <= best_depth.get(c, 0):
                    continue  # already explored at least as good
                seen_state[st] = max(seen_state.get(st, -1), nes)
                stack.append((c, nd, nes, nmask, on_path | {c}))
        for n, d in best_depth.items():
            pt = peak_through.get(n, (best_entry.get(n, frame(n)), False))
            per_root[n].append({"root": root, "depth": d,
                                "entry": best_entry.get(n, frame(n)),
                                "peak": pt[0], "peakBounded": pt[1]})

    # Assemble result.
    by_name = {}
    for n in names:
        pk, bounded = peak(n, set())
        entries = sorted(per_root[n], key=lambda e: -e["depth"])
        for e in entries:
            e.setdefault("peak", pk)
            e.setdefault("peakBounded", bounded)
            e["isAuto"] = e["root"] in auto_roots
            e["isPinned"] = e["root"] in pinned_roots
        max_d = max((e["depth"] for e in entries), default=0)
        dd, dd_bounded = down_depth(n, set())
        by_name[n] = {
            "name": n,
            "file": functions[n].file,
            "line": functions[n].line,
            "callees": callees[n],
            "indirect": [c for c in functions[n].indirect_callees if c in functions],
            "stackBytes": functions[n].stack_bytes,
            "stackQualifier": functions[n].stack_qualifier,
            "peak": pk,
            "peakBounded": bounded,
            "recursive": n in recursive,
            "recursiveViaFp": n in recursive_via_fp,
            "fpVerified": functions[n].fp_verified,
            # Whether THIS function is itself an entry point. A function is a
            # root only if it's pinned or caller-less (auto). Having a perRoot
            # entry with rootName==n is not sufficient (a pinned-pattern can tag
            # an interior function); these flags are authoritative.
            "isPinnedRoot": n in pinned_roots,
            "isAutoRoot": n in auto_roots,
            "depth": max_d,
            "downDepth": dd,
            "downDepthBounded": dd_bounded,
            "conditional": [
                {"targets": [t for t in ce.get("targets", []) if t in functions],
                 "cond": ce.get("cond")}
                for ce in functions[n].conditional_callees
                if any(t in functions for t in ce.get("targets", []))
            ],
            "perRoot": entries,
        }

    return {
        "byName": by_name,
        "roots": sorted(all_roots),
        "pinnedRoots": sorted(pinned_roots),
        "autoRoots": sorted(auto_roots),
    }
