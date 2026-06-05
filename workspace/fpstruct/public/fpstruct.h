#ifndef FPSTRUCT_H
#define FPSTRUCT_H

// Runtime struct-field function-pointer assignment scenarios for the
// fp-overrides suggester. These exercise cases where the field is assigned at
// RUN TIME (conditionally, in a different function, on a global, or through a
// pointer parameter), not via a constant initializer.

int fps_handler_a(int x);
int fps_handler_b(int x);
int fps_handler_c(int x);
int fps_handler_d(int x);

// 1) conditional assignment in the same function, then call
int fps_conditional_root(int sel);

// 2) global struct: one function assigns the field, another calls it
void fps_global_setup(int mode);
int fps_global_invoke(int x);
int fps_global_root(void);

// 3) assignment through a struct-pointer parameter (config function)
struct fps_dev;          // opaque to callers
int fps_ptr_param_root(void);

// 4) reassignment: field set to A then later to B before the call
int fps_reassign_root(void);

#endif
