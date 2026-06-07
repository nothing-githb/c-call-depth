// crosslevel/src/crosslevel.c — many functions calling each other across
// DIFFERENT hierarchy levels: a deep pipeline (s1..s6) with skip-level calls,
// shared mid helpers (diamonds), and a central hub reached from many callers at
// many depths. Good for testing the call graph's focus-anchored hover: focus a
// stage, hover xl_hub, and only the focus->hub corridor lights up.

#include "crosslevel/public/crosslevel.h"

// ---- leaves (small frames) ----
static int xl_crc(int x)  { volatile char b[64];  b[0] = (char)x; return b[0]; }
static int xl_log(int x)  { volatile char b[128]; b[0] = (char)x; return b[0]; }
static int xl_pack(int x) { volatile char b[96];  b[0] = (char)x; return b[0]; }

// ---- the hub: called from MANY functions at MANY levels ----
static int xl_hub(int x) {
    volatile char b[256]; b[0] = (char)x;
    return xl_crc(x) + xl_log(x) + b[0];
}

// ---- shared mid helpers (form diamonds: reached via several paths) ----
static int xl_mid_a(int x) {
    volatile char b[160]; b[0] = (char)x;
    return xl_hub(x) + xl_pack(x) + b[0];
}
static int xl_mid_b(int x) {
    volatile char b[192]; b[0] = (char)x;
    return xl_crc(x) + xl_log(x) + b[0];
}

// ---- deep pipeline s6 (deepest) .. s1, each with skip-level cross calls ----
static int xl_s6(int x) {
    volatile char b[112]; b[0] = (char)x;
    return xl_hub(x) + xl_mid_b(x) + b[0];
}
static int xl_s5(int x) {
    volatile char b[128]; b[0] = (char)x;
    return xl_s6(x) + xl_hub(x) + b[0];
}
static int xl_s4(int x) {
    volatile char b[144]; b[0] = (char)x;
    return xl_s5(x) + xl_mid_a(x) + b[0];
}
static int xl_s3(int x) {
    volatile char b[160]; b[0] = (char)x;
    return xl_s4(x) + xl_s6(x) /* skip a level */ + xl_hub(x) + b[0];
}
static int xl_s2(int x) {
    volatile char b[176]; b[0] = (char)x;
    return xl_s3(x) + xl_mid_a(x) + xl_hub(x) + b[0];
}
static int xl_s1(int x) {
    volatile char b[192]; b[0] = (char)x;
    return xl_s2(x) + xl_s4(x) /* skip a level */ + xl_hub(x) + b[0];
}

// ---- roots (pinned via the public header) ----
int xl_root(void) {
    volatile char b[208]; b[0] = 0;
    // straight into the pipeline, plus skip-level shortcuts and a direct hub call
    return xl_s1(0) + xl_s3(0) /* skip */ + xl_s5(0) /* skip */ + xl_hub(0) + xl_mid_b(0);
}

int xl_alt_root(void) {
    volatile char b[224]; b[0] = 0;
    // a second entry point that reaches the SAME hub from a different side —
    // when you focus a node under xl_root, these alt-root calls into the hub
    // are the "off-focus" callers that the hover now keeps dim.
    return xl_s2(0) + xl_mid_a(0) + xl_hub(0);
}
