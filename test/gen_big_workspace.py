#!/usr/bin/env python3
"""Generate a large, COMPLEX C workspace for end-to-end consistency tests.

~3000 globally-unique functions across many files, with:
  - high fan-in/out HUBS (dozens of callers AND dozens of callees each)
  - a deep linear CHAIN (long downDepth)
  - RECURSION: direct self, mutual A<->B, 3-node and N-node cycles
  - FUNCTION POINTERS: tables (resolved indirect edges) + unbound fp params
  - diamonds (shared callees) and multiple roots (public header = pinned roots)

It emits .c sources, headers, and MATCHING .su (stack-usage) files plus
compile_commands.json, so the real libclang + .su pipeline runs WITHOUT needing
gcc/make. Fully deterministic (index-based; no randomness).

A `--variant N` knob perturbs a few edges/stacks so tests can verify that a
"code change" propagates to every view.

Usage:
  python gen_big_workspace.py <out_dir> [num_functions] [--variant N]

Prints a one-line JSON summary of the intended topology to stdout (so tests can
cross-check the analyzer against the ground truth).
"""
import json
import os
import shutil
import sys

FRAME = 24  # extra bytes added to every emitted local frame (cosmetic)


def build_topology(N, variant):
    ROOTS = list(range(0, 20))
    HUBS = list(range(20, 60))
    CHAIN = list(range(60, 260))
    RECUR = list(range(260, 360))
    FP = list(range(360, 440))
    rest = list(range(440, N))
    half = len(rest) // 2
    CALLERS = rest[:half]      # workers that CALL hubs (give hubs fan-in)
    LEAVES = rest[half:]       # workers that hubs CALL (fan-out); pure DAG

    callees = {i: [] for i in range(N)}
    fp_tables = {}   # dispatcher idx -> [target idx]  (indirect, via a table)
    unbound = []     # dispatcher idx with an unbound fp PARAM

    def add(a, b):
        if a != b or True:
            callees[a].append(b)

    # ROOTS: reach hubs, the deep chain, some callers, recursion and fp.
    for ri, r in enumerate(ROOTS):
        add(r, HUBS[(ri * 2) % len(HUBS)])
        add(r, HUBS[(ri * 2 + 1) % len(HUBS)])
        add(r, CHAIN[0])
        add(r, CALLERS[(ri * 7) % len(CALLERS)])
        add(r, RECUR[ri % len(RECUR)])
        add(r, FP[ri % len(FP)])

    # HUBS: 30 leaf callees (overlapping slices -> diamonds) + forward hub edges.
    for hi, h in enumerate(HUBS):
        base = (hi * 23) % max(1, len(LEAVES) - 35)
        for k in range(30):
            add(h, LEAVES[base + k])
        if hi + 1 < len(HUBS):
            add(h, HUBS[hi + 1])
        if hi + 5 < len(HUBS):
            add(h, HUBS[hi + 5])

    # CHAIN: long linear chain (downDepth ~= len(CHAIN)).
    for k in range(len(CHAIN) - 1):
        add(CHAIN[k], CHAIN[k + 1])
    add(CHAIN[-1], LEAVES[0])

    # RECUR: 40 self, 20 mutual pairs (40), 5 three-cycles (15), 1 five-cycle (5).
    idx = 0
    for _ in range(40):
        n = RECUR[idx]; add(n, n); add(n, LEAVES[(idx * 3) % len(LEAVES)]); idx += 1
    for _ in range(20):
        a, b = RECUR[idx], RECUR[idx + 1]
        add(a, b); add(b, a); add(a, LEAVES[(idx * 5) % len(LEAVES)]); idx += 2
    for _ in range(5):
        x, y, z = RECUR[idx], RECUR[idx + 1], RECUR[idx + 2]
        add(x, y); add(y, z); add(z, x); add(y, LEAVES[(idx * 7) % len(LEAVES)]); idx += 3
    five = RECUR[idx:idx + 5]
    for k in range(5):
        add(five[k], five[(k + 1) % 5])
    idx += 5
    # any remaining RECUR indices: plain self-recursion
    while idx < len(RECUR):
        n = RECUR[idx]; add(n, n); idx += 1

    # FP: alternating resolved tables and unbound dispatchers.
    for fi, d in enumerate(FP):
        if fi % 2 == 0:
            targets = [LEAVES[(fi * 11 + k * 13) % len(LEAVES)] for k in range(6)]
            fp_tables[d] = sorted(set(targets))
            add(d, LEAVES[(fi * 3) % len(LEAVES)])  # one direct call too
        else:
            unbound.append(d)

    # CALLERS: each calls a hub (round-robin -> every hub gets dozens of callers)
    # plus a couple of forward callers.
    for wi, w in enumerate(CALLERS):
        add(w, HUBS[wi % len(HUBS)])
        if wi + 3 < len(CALLERS):
            add(w, CALLERS[wi + 3])
        if wi + 11 < len(CALLERS):
            add(w, CALLERS[wi + 11])

    # LEAVES: blocked DAG (depth bounded per block, diamonds within a block).
    BLK = 50
    for vi, v in enumerate(LEAVES):
        blk_end = (vi // BLK + 1) * BLK
        for off in (1, 5, 17):
            j = vi + off
            if j < blk_end and j < len(LEAVES):
                add(v, LEAVES[j])

    # ── variant perturbations: a "code change" that must propagate everywhere ──
    if variant == 1:
        # 1) remove HUBS[0]'s first leaf edge (an edge deletion)
        if callees[HUBS[0]]:
            callees[HUBS[0]] = callees[HUBS[0]][1:]
        # 2) add a brand-new edge: ROOTS[0] -> a deep CHAIN node (new reachability)
        add(ROOTS[0], CHAIN[100])
        # 3) (stack change handled in stack_bytes via variant)

    # stack sizes (deterministic; some big for severity). variant tweaks a few.
    stacks = {}
    for i in range(N):
        b = 16 + (i * 48) % 1600
        if i in HUBS:
            b += 512
        if i in CHAIN:
            b = 32 + (i % 7) * 8
        stacks[i] = b
    if variant == 1:
        stacks[HUBS[1]] = 9000  # a big stack change -> peak change everywhere above it

    # dedupe while preserving order
    for i in range(N):
        seen = set(); out = []
        for c in callees[i]:
            if c not in seen:
                seen.add(c); out.append(c)
        callees[i] = out

    groups = {"ROOTS": ROOTS, "HUBS": HUBS, "CHAIN": CHAIN, "RECUR": RECUR,
              "FP": FP, "CALLERS": CALLERS, "LEAVES": LEAVES}
    return callees, fp_tables, unbound, stacks, groups


def fname(i):
    return f"g{i:05d}"


def file_for(i, groups):
    # group consecutive indices into files of 40, in a per-category directory.
    for cat, lst in groups.items():
        if i in lst:
            pos = lst.index(i)
            return f"gen/{cat.lower()}/{cat.lower()}_{pos // 40:03d}.c"
    return "gen/misc/misc_000.c"


def main():
    args = [a for a in sys.argv[1:]]
    out = args[0]
    N = 3000
    variant = 0
    rest = args[1:]
    i = 0
    while i < len(rest):
        if rest[i] == "--variant":
            variant = int(rest[i + 1]); i += 2
        else:
            N = int(rest[i]); i += 1

    callees, fp_tables, unbound, stacks, groups = build_topology(N, variant)

    if os.path.isdir(out):
        shutil.rmtree(out)
    os.makedirs(out)

    # group functions by file
    by_file = {}
    for idx in range(N):
        by_file.setdefault(file_for(idx, groups), []).append(idx)

    # headers: public/api.h (roots -> pinned) and internal.h (everyone else + typedef)
    os.makedirs(os.path.join(out, "gen", "public"), exist_ok=True)
    roots = set(groups["ROOTS"])
    api = ["#ifndef GEN_API_H", "#define GEN_API_H"]
    for r in groups["ROOTS"]:
        api.append(f"int {fname(r)}(int x);")
    api += ["#endif"]
    _write(os.path.join(out, "gen", "public", "api.h"), "\n".join(api) + "\n")

    internal = ["#ifndef GEN_INTERNAL_H", "#define GEN_INTERNAL_H",
                "typedef int (*gen_fp_t)(int);"]
    for idx in range(N):
        if idx in roots:
            continue
        if idx in unbound:
            internal.append(f"int {fname(idx)}(gen_fp_t cb, int x);")
        else:
            internal.append(f"int {fname(idx)}(int x);")
    internal += ["#endif"]
    _write(os.path.join(out, "gen", "internal.h"), "\n".join(internal) + "\n")

    # emit .c files and matching .su files
    cc_entries = []
    su_dir = os.path.join(out, "build")
    for rel, idxs in sorted(by_file.items()):
        cpath = os.path.join(out, rel)
        os.makedirs(os.path.dirname(cpath), exist_ok=True)
        lines = ['#include "gen/internal.h"', '#include "gen/public/api.h"', ""]
        su_lines = []
        cbase = os.path.basename(rel)
        line_no = 4
        # function-pointer tables used by dispatchers in this file
        for idx in idxs:
            if idx in fp_tables:
                tbl = fp_tables[idx]
                lines.append("static gen_fp_t tbl_%s[] = { %s };" %
                             (fname(idx), ", ".join(fname(t) for t in tbl)))
                line_no += 1
        for idx in idxs:
            start_line = line_no + 1
            if idx in unbound:
                lines.append(f"int {fname(idx)}(gen_fp_t cb, int x) {{")
                lines.append(f"    volatile char f[{FRAME}]; f[0]=(char)x;")
                lines.append("    return cb(x) + f[0];")   # unbound indirect call
                lines.append("}")
                line_no += 4
            else:
                lines.append(f"int {fname(idx)}(int x) {{")
                lines.append(f"    volatile char f[{FRAME}]; int s=x; f[0]=(char)x;")
                for c in callees[idx]:
                    arg = "x - 1" if c == idx else "x"
                    lines.append(f"    if (x>0) s += {fname(c)}({arg});")
                if idx in fp_tables:
                    lines.append(f"    s += tbl_{fname(idx)}[x & 3](x);")  # indirect
                lines.append("    return s + f[0];")
                lines.append("}")
                line_no += 4 + len(callees[idx]) + (1 if idx in fp_tables else 0)
            lines.append("")
            line_no += 1
            su_lines.append(f"{cbase}:{start_line}:1:{fname(idx)}\t{stacks[idx]}\tstatic")
        _write(cpath, "\n".join(lines) + "\n")
        # .su next to the object in build/
        supath = os.path.join(su_dir, rel[:-2] + ".su")
        os.makedirs(os.path.dirname(supath), exist_ok=True)
        _write(supath, "\n".join(su_lines) + "\n")
        cc_entries.append({
            "directory": out.replace("\\", "/"),
            "file": rel,
            "command": f"gcc -O0 -fstack-usage -I. -c {rel}",
        })

    _write(os.path.join(out, "compile_commands.json"), json.dumps(cc_entries, indent=2))

    # ground-truth summary for the test to cross-check against the analyzer
    fanout = {fname(i): len(callees[i]) for i in range(N)}
    fanin = {}
    for i in range(N):
        for c in callees[i]:
            fanin[fname(c)] = fanin.get(fname(c), 0) + 1
    summary = {
        "functions": N,
        "files": len(by_file),
        "roots": [fname(r) for r in groups["ROOTS"]],
        "maxFanOut": max(fanout.values()),
        "maxFanIn": max(fanin.values()) if fanin else 0,
        "hubsWithBigFanInOut": sum(1 for h in groups["HUBS"]
                                   if fanout[fname(h)] >= 20 and fanin.get(fname(h), 0) >= 20),
        "chainHead": fname(groups["CHAIN"][0]),
        "chainLen": len(groups["CHAIN"]),
        "fpTables": {fname(d): [fname(t) for t in tbl] for d, tbl in fp_tables.items()},
        "unboundFp": [fname(d) for d in unbound],
        "variant": variant,
    }
    print(json.dumps(summary))


def _write(path, content):
    with open(path, "w", encoding="utf-8", newline="\n") as f:
        f.write(content)


if __name__ == "__main__":
    main()
