// fpkinds/src/fpkinds.c
//
// Demonstrates SEVERAL distinct function-pointer call shapes so each can be
// exercised with fp-overrides (narrow / add / conditional). Every dispatcher
// makes ONE indirect call; note its file:line and bind it in fp-overrides.json.
//
// The leaf handlers have deliberately different stack frames so per-root peaks
// change visibly when you narrow or condition the targets.
#include "fpkinds/public/fpkinds.h"

// ---- shared leaf handlers (different frame sizes) -------------------------
static int handler_small(int x)  { volatile char b[16];  b[0]=(char)x; return b[0]; }
static int handler_medium(int x) { volatile char b[256]; b[0]=(char)x; return b[0]; }
static int handler_large(int x)  { volatile char b[1024];b[0]=(char)x; return b[0]; }

typedef int (*op_t)(int);

// ===========================================================================
// 1) ARRAY TABLE: indirect call through a static array of function pointers.
//    vt[sel](x) — classic vtable / jump table.
// ===========================================================================
static op_t array_table[3] = { handler_small, handler_medium, handler_large };

int fp_array_dispatch(int sel) {
    volatile char frame[32]; frame[0] = 0;
    return array_table[sel & 3](sel) + frame[0];     // indirect via array
}

// ===========================================================================
// 2) STRUCT MEMBER: indirect call through a function pointer stored in a
//    struct (driver-ops / callback-table pattern).
// ===========================================================================
struct ops {
    int (*run)(int);
    int (*reset)(int);
};
static struct ops the_ops = { handler_medium, handler_small };

int fp_struct_dispatch(int x) {
    volatile char frame[32]; frame[0] = 0;
    return the_ops.run(x) + frame[0];                // indirect via struct member
}

// ===========================================================================
// 3) PARAMETER CALLBACK: the function pointer arrives as an argument.
//    A generic "apply" that invokes whatever callback it's handed.
// ===========================================================================
int fp_param_apply(op_t cb, int x) {
    volatile char frame[32]; frame[0] = 0;
    return cb(x) + frame[0];                          // indirect via parameter
}

int fp_param_caller(int x) {
    volatile char frame[16]; frame[0] = 0;
    return fp_param_apply(handler_large, x) + frame[0];
}

// ===========================================================================
// 4) GLOBAL POINTER: a single global function pointer, reassigned at runtime.
//    Good for conditional binding (which target is live depends on the path).
// ===========================================================================
static op_t current_mode = handler_small;

int fp_global_set_heavy(void) { current_mode = handler_large;  return 0; }
int fp_global_set_light(void) { current_mode = handler_small;  return 0; }

int fp_global_dispatch(int x) {
    volatile char frame[32]; frame[0] = 0;
    return current_mode(x) + frame[0];                // indirect via global ptr
}

// ===========================================================================
// 5) NESTED / RETURNED POINTER: a selector returns a function pointer that is
//    then called. Two-step indirection.
// ===========================================================================
static op_t pick(int sel) { return sel ? handler_large : handler_small; }

int fp_returned_dispatch(int sel) {
    volatile char frame[32]; frame[0] = 0;
    op_t fn = pick(sel);
    return fn(sel) + frame[0];                        // indirect via returned ptr
}

// ===========================================================================
// Roots that exercise each kind (so they show up as entry points).
// ===========================================================================
int fpkinds_root_a(void) {           // exercises array + struct
    volatile char frame[16]; frame[0] = 0;
    return fp_array_dispatch(2) + fp_struct_dispatch(1) + frame[0];
}

int fpkinds_root_b(void) {           // exercises param + returned + global
    volatile char frame[16]; frame[0] = 0;
    fp_global_set_heavy();
    return fp_param_caller(3) + fp_returned_dispatch(1)
         + fp_global_dispatch(2) + frame[0];
}
