// fpstruct/src/fpstruct.c
// Runtime / conditional / global / cross-function struct-field fp assignments.
#include "fpstruct/public/fpstruct.h"

typedef int (*fps_op_t)(int);

int fps_handler_a(int x) { volatile char b[128];  b[0]=(char)x; return b[0]; }
int fps_handler_b(int x) { volatile char b[512];  b[0]=(char)x; return b[0]; }
int fps_handler_c(int x) { volatile char b[1024]; b[0]=(char)x; return b[0]; }
int fps_handler_d(int x) { volatile char b[2048]; b[0]=(char)x; return b[0]; }

struct fps_dev {
    int id;
    fps_op_t handler;
};

// ===========================================================================
// 1) CONDITIONAL assignment in the same function, then invoked. Both branches
//    are possible at runtime, so BOTH targets should be suggested.
// ===========================================================================
int fps_conditional_root(int sel) {
    volatile char frame[32]; frame[0] = 0;
    struct fps_dev d;
    d.id = sel;
    if (sel & 1)
        d.handler = fps_handler_a;     // runtime branch A
    else
        d.handler = fps_handler_c;     // runtime branch B
    return d.handler(sel) + frame[0];  // indirect via field — A or C
}

// ===========================================================================
// 2) GLOBAL struct: the field is assigned in one function (fps_global_setup)
//    and invoked in a DIFFERENT function (fps_global_invoke). The suggester
//    must see the assignment even though it's not in the calling function.
// ===========================================================================
static struct fps_dev g_dev;

void fps_global_setup(int mode) {
    volatile char frame[16]; frame[0] = (char)mode;
    if (mode == 0)
        g_dev.handler = fps_handler_b;     // assigned here…
    else
        g_dev.handler = fps_handler_d;     // …or here (runtime)
}

int fps_global_invoke(int x) {
    volatile char frame[32]; frame[0] = 0;
    return g_dev.handler(x) + frame[0];    // …called HERE, in another function
}

int fps_global_root(void) {
    volatile char frame[16]; frame[0] = 0;
    fps_global_setup(0);
    return fps_global_invoke(5) + frame[0];
}

// ===========================================================================
// 3) Assignment through a STRUCT-POINTER PARAMETER (config function pattern).
//    fps_configure receives a struct* and assigns its field; the caller then
//    invokes it.
// ===========================================================================
static void fps_configure(struct fps_dev *d, int which) {
    volatile char frame[16]; frame[0] = (char)which;
    if (which)
        d->handler = fps_handler_c;        // assign via pointer param
    else
        d->handler = fps_handler_a;
}

int fps_ptr_param_root(void) {
    volatile char frame[32]; frame[0] = 0;
    struct fps_dev d;
    fps_configure(&d, 1);
    return d.handler(3) + frame[0];        // indirect via field set by callee
}

// ===========================================================================
// 4) REASSIGNMENT: field set to one target, then overwritten before the call.
//    Both assigned targets are candidates (the suggester over-approximates).
// ===========================================================================
int fps_reassign_root(void) {
    volatile char frame[32]; frame[0] = 0;
    struct fps_dev d;
    d.handler = fps_handler_a;             // first assignment
    d.handler = fps_handler_d;             // reassigned before the call
    return d.handler(7) + frame[0];        // indirect — A and D are candidates
}
