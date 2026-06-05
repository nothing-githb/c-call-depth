// fpadvanced/src/fpadvanced.c
// Hard cases for the fp-overrides template suggester.
#include "fpadvanced/public/fpadvanced.h"

typedef int (*op_t)(int);

// ---- leaf handlers --------------------------------------------------------
int adv_h_small(int x)  { volatile char b[64];   b[0]=(char)x; return b[0]; }
int adv_h_medium(int x) { volatile char b[256];  b[0]=(char)x; return b[0]; }
int adv_h_large(int x)  { volatile char b[1024]; b[0]=(char)x; return b[0]; }
int adv_h_huge(int x)   { volatile char b[4096]; b[0]=(char)x; return b[0]; }

// ===========================================================================
// 1) THREE-LEVEL parameter callback.
//    The callback is received as a parameter and forwarded down two more
//    levels before finally being invoked. A good suggester should trace what
//    adv_lvl3_top is called with (adv_h_large) up the chain to the call site
//    in adv_lvl3_bottom.
// ===========================================================================
int adv_lvl3_bottom(op_t cb, int x) {
    volatile char frame[32]; frame[0] = 0;
    return cb(x) + frame[0];                 // indirect via parameter (level 3)
}
int adv_lvl3_mid(op_t cb, int x) {
    volatile char frame[32]; frame[0] = 0;
    return adv_lvl3_bottom(cb, x) + frame[0];   // forwards cb down
}
int adv_lvl3_top(op_t cb, int x) {
    volatile char frame[32]; frame[0] = 0;
    return adv_lvl3_mid(cb, x) + frame[0];      // forwards cb down
}
int adv_lvl3_root(void) {
    volatile char frame[16]; frame[0] = 0;
    return adv_lvl3_top(adv_h_large, 7) + frame[0];   // concrete fn enters here
}

// ===========================================================================
// 2) MULTIPLE fp parameters, each invoked.
// ===========================================================================
int adv_apply2(op_t a, op_t b, int x) {
    volatile char frame[32]; frame[0] = 0;
    return a(x) + b(x) + frame[0];           // two indirect calls, params 0 and 1
}
int adv_apply3(op_t a, op_t b, op_t c, int x) {
    volatile char frame[32]; frame[0] = 0;
    return a(x) + b(x) + c(x) + frame[0];    // three indirect calls
}
int adv_multi_root(void) {
    volatile char frame[16]; frame[0] = 0;
    int s = 0;
    s += adv_apply2(adv_h_small, adv_h_large, 1);
    s += adv_apply3(adv_h_medium, adv_h_huge, adv_h_small, 2);
    return s + frame[0];
}

// ===========================================================================
// 3) STRUCT FIELD ASSIGNMENT: a handler is assigned to a struct field, then
//    the field is invoked. The suggester should propose the assigned target.
// ===========================================================================
struct adv_dev {
    op_t on_event;
    op_t on_error;
};
int adv_struct_assign_root(void) {
    volatile char frame[32]; frame[0] = 0;
    struct adv_dev d;
    d.on_event = adv_h_huge;       // assignment to struct field
    d.on_error = adv_h_small;      // assignment to struct field
    int s = d.on_event(3) + d.on_error(4);   // indirect via struct fields
    return s + frame[0];
}

// ===========================================================================
// 4) ARRAY OF STRUCTs with fp fields.
// ===========================================================================
struct adv_entry { int id; op_t fn; };
static struct adv_entry adv_tbl[3] = {
    { 0, adv_h_small },
    { 1, adv_h_medium },
    { 2, adv_h_large },
};
int adv_array_struct_root(void) {
    volatile char frame[32]; frame[0] = 0;
    int s = 0;
    for (int i = 0; i < 3; i++) s += adv_tbl[i].fn(i);   // indirect via array-of-struct field
    return s + frame[0];
}

// ===========================================================================
// 5) WRAPPER forwarding a received callback to a generic apply.
// ===========================================================================
static int adv_invoke(op_t cb, int x) {
    volatile char frame[32]; frame[0] = 0;
    return cb(x) + frame[0];                 // indirect via parameter
}
static int adv_forward(op_t cb, int x) {
    volatile char frame[16]; frame[0] = 0;
    return adv_invoke(cb, x) + frame[0];     // forwards to adv_invoke
}
int adv_wrapper_root(void) {
    volatile char frame[16]; frame[0] = 0;
    return adv_forward(adv_h_medium, 9) + frame[0];
}
