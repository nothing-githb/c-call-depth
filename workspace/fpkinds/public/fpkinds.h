// fpkinds/public/fpkinds.h
#ifndef FPKINDS_H
#define FPKINDS_H

typedef int (*op_t)(int);

int fp_array_dispatch(int sel);
int fp_struct_dispatch(int x);
int fp_param_apply(op_t cb, int x);
int fp_param_caller(int x);
int fp_global_set_heavy(void);
int fp_global_set_light(void);
int fp_global_dispatch(int x);
int fp_returned_dispatch(int sel);

int fpkinds_root_a(void);
int fpkinds_root_b(void);

#endif
