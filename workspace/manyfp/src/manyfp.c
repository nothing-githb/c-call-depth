// manyfp/src/manyfp.c — 50 unbound function-pointer dispatchers (generated)
#include "manyfp/public/manyfp.h"

typedef int (*mop_t)(int);
static int mfp_leaf_a(int x) { volatile char b[64];  b[0]=(char)x; return b[0]; }
static int mfp_leaf_b(int x) { volatile char b[128]; b[0]=(char)x; return b[0]; }
static int mfp_leaf_c(int x) { volatile char b[256]; b[0]=(char)x; return b[0]; }
static mop_t mfp_table[3] = { mfp_leaf_a, mfp_leaf_b, mfp_leaf_c };

int many_fp_00(int sel) {
    volatile char frame[16]; frame[0] = 0;
    return mfp_table[sel % 3](sel) + frame[0];   // indirect, no override
}

int many_fp_01(int sel) {
    volatile char frame[32]; frame[0] = 0;
    return mfp_table[sel % 3](sel) + frame[0];   // indirect, no override
}

int many_fp_02(int sel) {
    volatile char frame[48]; frame[0] = 0;
    return mfp_table[sel % 3](sel) + frame[0];   // indirect, no override
}

int many_fp_03(int sel) {
    volatile char frame[64]; frame[0] = 0;
    return mfp_table[sel % 3](sel) + frame[0];   // indirect, no override
}

int many_fp_04(int sel) {
    volatile char frame[80]; frame[0] = 0;
    return mfp_table[sel % 3](sel) + frame[0];   // indirect, no override
}

int many_fp_05(int sel) {
    volatile char frame[96]; frame[0] = 0;
    return mfp_table[sel % 3](sel) + frame[0];   // indirect, no override
}

int many_fp_06(int sel) {
    volatile char frame[16]; frame[0] = 0;
    return mfp_table[sel % 3](sel) + frame[0];   // indirect, no override
}

int many_fp_07(int sel) {
    volatile char frame[32]; frame[0] = 0;
    return mfp_table[sel % 3](sel) + frame[0];   // indirect, no override
}

int many_fp_08(int sel) {
    volatile char frame[48]; frame[0] = 0;
    return mfp_table[sel % 3](sel) + frame[0];   // indirect, no override
}

int many_fp_09(int sel) {
    volatile char frame[64]; frame[0] = 0;
    return mfp_table[sel % 3](sel) + frame[0];   // indirect, no override
}

int many_fp_10(int sel) {
    volatile char frame[80]; frame[0] = 0;
    return mfp_table[sel % 3](sel) + frame[0];   // indirect, no override
}

int many_fp_11(int sel) {
    volatile char frame[96]; frame[0] = 0;
    return mfp_table[sel % 3](sel) + frame[0];   // indirect, no override
}

int many_fp_12(int sel) {
    volatile char frame[16]; frame[0] = 0;
    return mfp_table[sel % 3](sel) + frame[0];   // indirect, no override
}

int many_fp_13(int sel) {
    volatile char frame[32]; frame[0] = 0;
    return mfp_table[sel % 3](sel) + frame[0];   // indirect, no override
}

int many_fp_14(int sel) {
    volatile char frame[48]; frame[0] = 0;
    return mfp_table[sel % 3](sel) + frame[0];   // indirect, no override
}

int many_fp_15(int sel) {
    volatile char frame[64]; frame[0] = 0;
    return mfp_table[sel % 3](sel) + frame[0];   // indirect, no override
}

int many_fp_16(int sel) {
    volatile char frame[80]; frame[0] = 0;
    return mfp_table[sel % 3](sel) + frame[0];   // indirect, no override
}

int many_fp_17(int sel) {
    volatile char frame[96]; frame[0] = 0;
    return mfp_table[sel % 3](sel) + frame[0];   // indirect, no override
}

int many_fp_18(int sel) {
    volatile char frame[16]; frame[0] = 0;
    return mfp_table[sel % 3](sel) + frame[0];   // indirect, no override
}

int many_fp_19(int sel) {
    volatile char frame[32]; frame[0] = 0;
    return mfp_table[sel % 3](sel) + frame[0];   // indirect, no override
}

int many_fp_20(int sel) {
    volatile char frame[48]; frame[0] = 0;
    return mfp_table[sel % 3](sel) + frame[0];   // indirect, no override
}

int many_fp_21(int sel) {
    volatile char frame[64]; frame[0] = 0;
    return mfp_table[sel % 3](sel) + frame[0];   // indirect, no override
}

int many_fp_22(int sel) {
    volatile char frame[80]; frame[0] = 0;
    return mfp_table[sel % 3](sel) + frame[0];   // indirect, no override
}

int many_fp_23(int sel) {
    volatile char frame[96]; frame[0] = 0;
    return mfp_table[sel % 3](sel) + frame[0];   // indirect, no override
}

int many_fp_24(int sel) {
    volatile char frame[16]; frame[0] = 0;
    return mfp_table[sel % 3](sel) + frame[0];   // indirect, no override
}

int many_fp_25(int sel) {
    volatile char frame[32]; frame[0] = 0;
    return mfp_table[sel % 3](sel) + frame[0];   // indirect, no override
}

int many_fp_26(int sel) {
    volatile char frame[48]; frame[0] = 0;
    return mfp_table[sel % 3](sel) + frame[0];   // indirect, no override
}

int many_fp_27(int sel) {
    volatile char frame[64]; frame[0] = 0;
    return mfp_table[sel % 3](sel) + frame[0];   // indirect, no override
}

int many_fp_28(int sel) {
    volatile char frame[80]; frame[0] = 0;
    return mfp_table[sel % 3](sel) + frame[0];   // indirect, no override
}

int many_fp_29(int sel) {
    volatile char frame[96]; frame[0] = 0;
    return mfp_table[sel % 3](sel) + frame[0];   // indirect, no override
}

int many_fp_30(int sel) {
    volatile char frame[16]; frame[0] = 0;
    return mfp_table[sel % 3](sel) + frame[0];   // indirect, no override
}

int many_fp_31(int sel) {
    volatile char frame[32]; frame[0] = 0;
    return mfp_table[sel % 3](sel) + frame[0];   // indirect, no override
}

int many_fp_32(int sel) {
    volatile char frame[48]; frame[0] = 0;
    return mfp_table[sel % 3](sel) + frame[0];   // indirect, no override
}

int many_fp_33(int sel) {
    volatile char frame[64]; frame[0] = 0;
    return mfp_table[sel % 3](sel) + frame[0];   // indirect, no override
}

int many_fp_34(int sel) {
    volatile char frame[80]; frame[0] = 0;
    return mfp_table[sel % 3](sel) + frame[0];   // indirect, no override
}

int many_fp_35(int sel) {
    volatile char frame[96]; frame[0] = 0;
    return mfp_table[sel % 3](sel) + frame[0];   // indirect, no override
}

int many_fp_36(int sel) {
    volatile char frame[16]; frame[0] = 0;
    return mfp_table[sel % 3](sel) + frame[0];   // indirect, no override
}

int many_fp_37(int sel) {
    volatile char frame[32]; frame[0] = 0;
    return mfp_table[sel % 3](sel) + frame[0];   // indirect, no override
}

int many_fp_38(int sel) {
    volatile char frame[48]; frame[0] = 0;
    return mfp_table[sel % 3](sel) + frame[0];   // indirect, no override
}

int many_fp_39(int sel) {
    volatile char frame[64]; frame[0] = 0;
    return mfp_table[sel % 3](sel) + frame[0];   // indirect, no override
}

int many_fp_40(int sel) {
    volatile char frame[80]; frame[0] = 0;
    return mfp_table[sel % 3](sel) + frame[0];   // indirect, no override
}

int many_fp_41(int sel) {
    volatile char frame[96]; frame[0] = 0;
    return mfp_table[sel % 3](sel) + frame[0];   // indirect, no override
}

int many_fp_42(int sel) {
    volatile char frame[16]; frame[0] = 0;
    return mfp_table[sel % 3](sel) + frame[0];   // indirect, no override
}

int many_fp_43(int sel) {
    volatile char frame[32]; frame[0] = 0;
    return mfp_table[sel % 3](sel) + frame[0];   // indirect, no override
}

int many_fp_44(int sel) {
    volatile char frame[48]; frame[0] = 0;
    return mfp_table[sel % 3](sel) + frame[0];   // indirect, no override
}

int many_fp_45(int sel) {
    volatile char frame[64]; frame[0] = 0;
    return mfp_table[sel % 3](sel) + frame[0];   // indirect, no override
}

int many_fp_46(int sel) {
    volatile char frame[80]; frame[0] = 0;
    return mfp_table[sel % 3](sel) + frame[0];   // indirect, no override
}

int many_fp_47(int sel) {
    volatile char frame[96]; frame[0] = 0;
    return mfp_table[sel % 3](sel) + frame[0];   // indirect, no override
}

int many_fp_48(int sel) {
    volatile char frame[16]; frame[0] = 0;
    return mfp_table[sel % 3](sel) + frame[0];   // indirect, no override
}

int many_fp_49(int sel) {
    volatile char frame[32]; frame[0] = 0;
    return mfp_table[sel % 3](sel) + frame[0];   // indirect, no override
}

int manyfp_root(void) {
    volatile char frame[16]; frame[0] = 0;
    int s = 0;
    for (int i = 0; i < 3; i++) s += many_fp_00(i);
    s += many_fp_49(2);
    return s + frame[0];
}
