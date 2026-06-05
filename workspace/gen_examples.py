#!/usr/bin/env python3
"""Generate deterministic C examples for the big-workspace:
   - 50 recursive functions (several shapes)
   - 50 unbound function-pointer dispatchers
   - a peak-verification module with hand-computable call hierarchies
All frames are fixed-size local arrays so `gcc -fstack-usage` reports a known
per-function stack, letting tests assert exact peaks.
"""
import os, textwrap

WS = "/tmp/bw-ship"

# ---------------------------------------------------------------------------
# 1) RECURSION: 50 functions across direct / mutual / 3-cycle / deep shapes.
# ---------------------------------------------------------------------------
def gen_recursion():
    lines = []
    lines.append("// recur/src/recur.c — 50 recursive functions (generated)")
    lines.append('#include "recur/public/recur.h"')
    lines.append("")
    lines.append("// Each function has a fixed local frame so stack usage is deterministic.")
    lines.append("")
    count = 0
    # (a) 21 direct self-recursion functions (20 + 1 to round the total to 50)
    for i in range(21):
        lines.append(f"int rec_self_{i:02d}(int n) {{")
        lines.append(f"    volatile char frame[{16 + (i % 8) * 16}]; frame[0] = (char)n;")
        lines.append(f"    if (n <= 0) return frame[0];")
        lines.append(f"    return rec_self_{i:02d}(n - 1) + frame[0];")
        lines.append("}")
        lines.append("")
        count += 1
    # (b) 20 mutual-recursion functions in 10 A<->B pairs
    for p in range(10):
        a, b = f"rec_ping_{p:02d}", f"rec_pong_{p:02d}"
        lines.append(f"int {b}(int n);")
        lines.append(f"int {a}(int n) {{")
        lines.append(f"    volatile char frame[{32 + p * 8}]; frame[0] = (char)n;")
        lines.append(f"    if (n <= 0) return frame[0];")
        lines.append(f"    return {b}(n - 1) + frame[0];")
        lines.append("}")
        lines.append(f"int {b}(int n) {{")
        lines.append(f"    volatile char frame[{24 + p * 8}]; frame[0] = (char)n;")
        lines.append(f"    if (n <= 0) return frame[0];")
        lines.append(f"    return {a}(n - 1) + frame[0];")
        lines.append("}")
        lines.append("")
        count += 2
    # (c) 10 three-function cycles X->Y->Z->X  (but only first of each cycle
    #     counted toward 50; we add 10 functions total = ~3-4 cycles)
    triples = 4  # 4 cycles * 3 = 12 functions -> brings us to ~52; trim to 50
    made = 0
    for c in range(triples):
        names = [f"rec_cyc_{c}_{k}" for k in range(3)]
        for k in range(3):
            nxt = names[(k + 1) % 3]
            lines.append(f"int {names[(k+1)%3]}(int n);" if k == 0 else "")
        # forward declares for all three
        lines = [l for l in lines if l != ""] if False else lines
        for k in range(3):
            lines.append(f"int {names[k]}(int n);")
        for k in range(3):
            nxt = names[(k + 1) % 3]
            lines.append(f"int {names[k]}(int n) {{")
            lines.append(f"    volatile char frame[{40 + k * 8}]; frame[0] = (char)n;")
            lines.append(f"    if (n <= 0) return frame[0];")
            lines.append(f"    return {nxt}(n - 1) + frame[0];")
            lines.append("}")
            made += 1
            count += 1
            if count >= 50:
                break
        if count >= 50:
            break
    # root that calls a representative set (so they're reachable, not just roots)
    lines.append("int recur_root(void) {")
    lines.append("    volatile char frame[16]; frame[0] = 0;")
    lines.append("    int s = 0;")
    lines.append("    s += rec_self_00(5); s += rec_self_19(5);")
    lines.append("    s += rec_ping_00(5); s += rec_ping_09(5);")
    lines.append("    s += rec_cyc_0_0(5);")
    lines.append("    return s + frame[0];")
    lines.append("}")
    lines.append("")
    # header
    decls = []
    for i in range(21):
        decls.append(f"int rec_self_{i:02d}(int n);")
    for p in range(10):
        decls.append(f"int rec_ping_{p:02d}(int n);")
        decls.append(f"int rec_pong_{p:02d}(int n);")
    decls.append("int recur_root(void);")
    hdr = "#ifndef RECUR_H\n#define RECUR_H\n" + "\n".join(decls) + "\n#endif\n"
    return "\n".join(lines), hdr, count

# ---------------------------------------------------------------------------
# 2) UNBOUND FP: 50 dispatchers each making one indirect call with no override.
# ---------------------------------------------------------------------------
def gen_manyfp():
    lines = []
    lines.append("// manyfp/src/manyfp.c — 50 unbound function-pointer dispatchers (generated)")
    lines.append('#include "manyfp/public/manyfp.h"')
    lines.append("")
    lines.append("typedef int (*mop_t)(int);")
    lines.append("static int mfp_leaf_a(int x) { volatile char b[64];  b[0]=(char)x; return b[0]; }")
    lines.append("static int mfp_leaf_b(int x) { volatile char b[128]; b[0]=(char)x; return b[0]; }")
    lines.append("static int mfp_leaf_c(int x) { volatile char b[256]; b[0]=(char)x; return b[0]; }")
    lines.append("static mop_t mfp_table[3] = { mfp_leaf_a, mfp_leaf_b, mfp_leaf_c };")
    lines.append("")
    for i in range(50):
        lines.append(f"int many_fp_{i:02d}(int sel) {{")
        lines.append(f"    volatile char frame[{16 + (i % 6) * 16}]; frame[0] = 0;")
        lines.append(f"    return mfp_table[sel % 3](sel) + frame[0];   // indirect, no override")
        lines.append("}")
        lines.append("")
    lines.append("int manyfp_root(void) {")
    lines.append("    volatile char frame[16]; frame[0] = 0;")
    lines.append("    int s = 0;")
    lines.append("    for (int i = 0; i < 3; i++) s += many_fp_00(i);")
    lines.append("    s += many_fp_49(2);")
    lines.append("    return s + frame[0];")
    lines.append("}")
    lines.append("")
    decls = [f"int many_fp_{i:02d}(int sel);" for i in range(50)]
    decls.append("int manyfp_root(void);")
    hdr = "#ifndef MANYFP_H\n#define MANYFP_H\n" + "\n".join(decls) + "\n#endif\n"
    return "\n".join(lines), hdr

# ---------------------------------------------------------------------------
# 3) PEAK VERIFICATION: linear + branching chains with KNOWN frames so the
#    test can assert exact peak = sum along the worst path.
#    Frames are exact powers so sums are unambiguous.
# ---------------------------------------------------------------------------
def gen_peakchain():
    lines = []
    lines.append("// peakverify/src/peakverify.c — hand-computable peaks (generated)")
    lines.append('#include "peakverify/public/peakverify.h"')
    lines.append("")
    # Linear chain: pv_lin0 -> pv_lin1 -> ... -> pv_lin5, frames 100,200,...,600
    # (gcc adds overhead, so we use big arrays and the test reads the .su to get
    #  exact per-fn frames, then checks peak == sum along the path.)
    N = 6
    for i in range(N):
        callee = f"pv_lin{i+1}(x)" if i < N - 1 else "x"
        sz = (i + 1) * 256
        lines.append(f"int pv_lin{i}(int x) {{")
        lines.append(f"    volatile char frame[{sz}]; frame[0] = (char)x;")
        if i < N - 1:
            lines.append(f"    return pv_lin{i+1}(x) + frame[0];")
        else:
            lines.append(f"    return frame[0];")
        lines.append("}")
        lines.append("")
    # Branching: pv_branch calls two subtrees with different depths; peak must
    # follow the HEAVIER subtree.
    lines.append("int pv_light_leaf(int x) { volatile char b[128]; b[0]=(char)x; return b[0]; }")
    lines.append("int pv_heavy_mid(int x)  { volatile char b[2048]; b[0]=(char)x; return pv_lin0(x) + b[0]; }")
    lines.append("int pv_branch(int x) {")
    lines.append("    volatile char frame[512]; frame[0] = (char)x;")
    lines.append("    return pv_light_leaf(x) + pv_heavy_mid(x) + frame[0];")
    lines.append("}")
    lines.append("")
    # Diamond: top -> {l, r} -> bottom. Shared bottom must be counted once per path.
    lines.append("int pv_bottom(int x) { volatile char b[1024]; b[0]=(char)x; return b[0]; }")
    lines.append("int pv_left(int x)   { volatile char b[256];  b[0]=(char)x; return pv_bottom(x) + b[0]; }")
    lines.append("int pv_right(int x)  { volatile char b[768];  b[0]=(char)x; return pv_bottom(x) + b[0]; }")
    lines.append("int pv_top(int x) {")
    lines.append("    volatile char frame[256]; frame[0] = (char)x;")
    lines.append("    return pv_left(x) + pv_right(x) + frame[0];")
    lines.append("}")
    lines.append("")
    decls = [f"int pv_lin{i}(int x);" for i in range(N)]
    decls += ["int pv_light_leaf(int x);", "int pv_heavy_mid(int x);", "int pv_branch(int x);",
              "int pv_bottom(int x);", "int pv_left(int x);", "int pv_right(int x);", "int pv_top(int x);"]
    hdr = "#ifndef PEAKVERIFY_H\n#define PEAKVERIFY_H\n" + "\n".join(decls) + "\n#endif\n"
    return "\n".join(lines), hdr

def write(path, content):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w") as f:
        f.write(content)

rec_c, rec_h, rec_count = gen_recursion()
write(f"{WS}/recur/src/recur.c", rec_c)
write(f"{WS}/recur/public/recur.h", rec_h)

mfp_c, mfp_h = gen_manyfp()
write(f"{WS}/manyfp/src/manyfp.c", mfp_c)
write(f"{WS}/manyfp/public/manyfp.h", mfp_h)

pv_c, pv_h = gen_peakchain()
write(f"{WS}/peakverify/src/peakverify.c", pv_c)
write(f"{WS}/peakverify/public/peakverify.h", pv_h)

print(f"recursion functions generated: {rec_count}")
print("manyfp dispatchers: 50")
print("peakverify module written")

# ---------------------------------------------------------------------------
# LONG CYCLE: a single 100-hop recursion loop lc_00 → lc_01 → … → lc_99 → lc_00.
# Exercises the side panel's shortest-cycle BFS on a real analysis (a loop far
# longer than the DFS depth cap), and the graph's backward-edge routing.
# ---------------------------------------------------------------------------
def gen_longcycle(n=100):
    lines = ["// longcycle/src/longcycle.c — one 100-hop recursion loop (generated)",
             '#include "longcycle/public/longcycle.h"', ""]
    for i in range(n):
        nxt = (i + 1) % n
        lines.append(f"int lc_{i:02d}(int x) {{")
        lines.append(f"    volatile char frame[{16 + (i % 4) * 16}]; frame[0] = (char)x;")
        lines.append(f"    if (x <= 0) return frame[0];")
        lines.append(f"    return lc_{nxt:02d}(x - 1) + frame[0];")
        lines.append("}")
        lines.append("")
    lines.append("int longcycle_root(void) {")
    lines.append("    volatile char frame[16]; frame[0] = 0;")
    lines.append("    return lc_00(250) + frame[0];")
    lines.append("}")
    lines.append("")
    decls = [f"int lc_{i:02d}(int x);" for i in range(n)]
    decls.append("int longcycle_root(void);")
    hdr = "#ifndef LONGCYCLE_H\n#define LONGCYCLE_H\n" + "\n".join(decls) + "\n#endif\n"
    return "\n".join(lines), hdr

lc_c, lc_h = gen_longcycle(100)
write(f"{WS}/longcycle/src/longcycle.c", lc_c)
write(f"{WS}/longcycle/public/longcycle.h", lc_h)
print("longcycle module written: 100-hop loop lc_00..99")
