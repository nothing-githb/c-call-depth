#ifndef FPADVANCED_H
#define FPADVANCED_H

// Advanced function-pointer template scenarios for the fp-overrides suggester:
//   1) callback passed through THREE levels of parameters before being called
//   2) a function taking MULTIPLE fp parameters, each called
//   3) struct-field assignment (s.handler = fn; ... s.handler(x))
//   4) array-of-struct fp fields
//   5) callback chosen by a wrapper that itself receives it as a parameter
//
// Roots exercise each so they are reachable.

// Leaf handlers (distinct frames so peaks differ visibly).
int adv_h_small(int x);
int adv_h_medium(int x);
int adv_h_large(int x);
int adv_h_huge(int x);

// 1) three-level parameter callback
int adv_lvl3_bottom(int (*cb)(int), int x);
int adv_lvl3_mid(int (*cb)(int), int x);
int adv_lvl3_top(int (*cb)(int), int x);
int adv_lvl3_root(void);

// 2) multiple fp parameters
int adv_apply2(int (*a)(int), int (*b)(int), int x);
int adv_apply3(int (*a)(int), int (*b)(int), int (*c)(int), int x);
int adv_multi_root(void);

// 3) struct field assignment
int adv_struct_assign_root(void);

// 4) array of struct fp fields
int adv_array_struct_root(void);

// 5) wrapper that forwards a received callback
int adv_wrapper_root(void);

#endif
