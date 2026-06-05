// recur/src/recur.c — 50 recursive functions (generated)
#include "recur/public/recur.h"

// Each function has a fixed local frame so stack usage is deterministic.

int rec_self_00(int n) {
    volatile char frame[16]; frame[0] = (char)n;
    if (n <= 0) return frame[0];
    return rec_self_00(n - 1) + frame[0];
}

int rec_self_01(int n) {
    volatile char frame[32]; frame[0] = (char)n;
    if (n <= 0) return frame[0];
    return rec_self_01(n - 1) + frame[0];
}

int rec_self_02(int n) {
    volatile char frame[48]; frame[0] = (char)n;
    if (n <= 0) return frame[0];
    return rec_self_02(n - 1) + frame[0];
}

int rec_self_03(int n) {
    volatile char frame[64]; frame[0] = (char)n;
    if (n <= 0) return frame[0];
    return rec_self_03(n - 1) + frame[0];
}

int rec_self_04(int n) {
    volatile char frame[80]; frame[0] = (char)n;
    if (n <= 0) return frame[0];
    return rec_self_04(n - 1) + frame[0];
}

int rec_self_05(int n) {
    volatile char frame[96]; frame[0] = (char)n;
    if (n <= 0) return frame[0];
    return rec_self_05(n - 1) + frame[0];
}

int rec_self_06(int n) {
    volatile char frame[112]; frame[0] = (char)n;
    if (n <= 0) return frame[0];
    return rec_self_06(n - 1) + frame[0];
}

int rec_self_07(int n) {
    volatile char frame[128]; frame[0] = (char)n;
    if (n <= 0) return frame[0];
    return rec_self_07(n - 1) + frame[0];
}

int rec_self_08(int n) {
    volatile char frame[16]; frame[0] = (char)n;
    if (n <= 0) return frame[0];
    return rec_self_08(n - 1) + frame[0];
}

int rec_self_09(int n) {
    volatile char frame[32]; frame[0] = (char)n;
    if (n <= 0) return frame[0];
    return rec_self_09(n - 1) + frame[0];
}

int rec_self_10(int n) {
    volatile char frame[48]; frame[0] = (char)n;
    if (n <= 0) return frame[0];
    return rec_self_10(n - 1) + frame[0];
}

int rec_self_11(int n) {
    volatile char frame[64]; frame[0] = (char)n;
    if (n <= 0) return frame[0];
    return rec_self_11(n - 1) + frame[0];
}

int rec_self_12(int n) {
    volatile char frame[80]; frame[0] = (char)n;
    if (n <= 0) return frame[0];
    return rec_self_12(n - 1) + frame[0];
}

int rec_self_13(int n) {
    volatile char frame[96]; frame[0] = (char)n;
    if (n <= 0) return frame[0];
    return rec_self_13(n - 1) + frame[0];
}

int rec_self_14(int n) {
    volatile char frame[112]; frame[0] = (char)n;
    if (n <= 0) return frame[0];
    return rec_self_14(n - 1) + frame[0];
}

int rec_self_15(int n) {
    volatile char frame[128]; frame[0] = (char)n;
    if (n <= 0) return frame[0];
    return rec_self_15(n - 1) + frame[0];
}

int rec_self_16(int n) {
    volatile char frame[16]; frame[0] = (char)n;
    if (n <= 0) return frame[0];
    return rec_self_16(n - 1) + frame[0];
}

int rec_self_17(int n) {
    volatile char frame[32]; frame[0] = (char)n;
    if (n <= 0) return frame[0];
    return rec_self_17(n - 1) + frame[0];
}

int rec_self_18(int n) {
    volatile char frame[48]; frame[0] = (char)n;
    if (n <= 0) return frame[0];
    return rec_self_18(n - 1) + frame[0];
}

int rec_self_19(int n) {
    volatile char frame[64]; frame[0] = (char)n;
    if (n <= 0) return frame[0];
    return rec_self_19(n - 1) + frame[0];
}

int rec_self_20(int n) {
    volatile char frame[80]; frame[0] = (char)n;
    if (n <= 0) return frame[0];
    return rec_self_20(n - 1) + frame[0];
}

int rec_pong_00(int n);
int rec_ping_00(int n) {
    volatile char frame[32]; frame[0] = (char)n;
    if (n <= 0) return frame[0];
    return rec_pong_00(n - 1) + frame[0];
}
int rec_pong_00(int n) {
    volatile char frame[24]; frame[0] = (char)n;
    if (n <= 0) return frame[0];
    return rec_ping_00(n - 1) + frame[0];
}

int rec_pong_01(int n);
int rec_ping_01(int n) {
    volatile char frame[40]; frame[0] = (char)n;
    if (n <= 0) return frame[0];
    return rec_pong_01(n - 1) + frame[0];
}
int rec_pong_01(int n) {
    volatile char frame[32]; frame[0] = (char)n;
    if (n <= 0) return frame[0];
    return rec_ping_01(n - 1) + frame[0];
}

int rec_pong_02(int n);
int rec_ping_02(int n) {
    volatile char frame[48]; frame[0] = (char)n;
    if (n <= 0) return frame[0];
    return rec_pong_02(n - 1) + frame[0];
}
int rec_pong_02(int n) {
    volatile char frame[40]; frame[0] = (char)n;
    if (n <= 0) return frame[0];
    return rec_ping_02(n - 1) + frame[0];
}

int rec_pong_03(int n);
int rec_ping_03(int n) {
    volatile char frame[56]; frame[0] = (char)n;
    if (n <= 0) return frame[0];
    return rec_pong_03(n - 1) + frame[0];
}
int rec_pong_03(int n) {
    volatile char frame[48]; frame[0] = (char)n;
    if (n <= 0) return frame[0];
    return rec_ping_03(n - 1) + frame[0];
}

int rec_pong_04(int n);
int rec_ping_04(int n) {
    volatile char frame[64]; frame[0] = (char)n;
    if (n <= 0) return frame[0];
    return rec_pong_04(n - 1) + frame[0];
}
int rec_pong_04(int n) {
    volatile char frame[56]; frame[0] = (char)n;
    if (n <= 0) return frame[0];
    return rec_ping_04(n - 1) + frame[0];
}

int rec_pong_05(int n);
int rec_ping_05(int n) {
    volatile char frame[72]; frame[0] = (char)n;
    if (n <= 0) return frame[0];
    return rec_pong_05(n - 1) + frame[0];
}
int rec_pong_05(int n) {
    volatile char frame[64]; frame[0] = (char)n;
    if (n <= 0) return frame[0];
    return rec_ping_05(n - 1) + frame[0];
}

int rec_pong_06(int n);
int rec_ping_06(int n) {
    volatile char frame[80]; frame[0] = (char)n;
    if (n <= 0) return frame[0];
    return rec_pong_06(n - 1) + frame[0];
}
int rec_pong_06(int n) {
    volatile char frame[72]; frame[0] = (char)n;
    if (n <= 0) return frame[0];
    return rec_ping_06(n - 1) + frame[0];
}

int rec_pong_07(int n);
int rec_ping_07(int n) {
    volatile char frame[88]; frame[0] = (char)n;
    if (n <= 0) return frame[0];
    return rec_pong_07(n - 1) + frame[0];
}
int rec_pong_07(int n) {
    volatile char frame[80]; frame[0] = (char)n;
    if (n <= 0) return frame[0];
    return rec_ping_07(n - 1) + frame[0];
}

int rec_pong_08(int n);
int rec_ping_08(int n) {
    volatile char frame[96]; frame[0] = (char)n;
    if (n <= 0) return frame[0];
    return rec_pong_08(n - 1) + frame[0];
}
int rec_pong_08(int n) {
    volatile char frame[88]; frame[0] = (char)n;
    if (n <= 0) return frame[0];
    return rec_ping_08(n - 1) + frame[0];
}

int rec_pong_09(int n);
int rec_ping_09(int n) {
    volatile char frame[104]; frame[0] = (char)n;
    if (n <= 0) return frame[0];
    return rec_pong_09(n - 1) + frame[0];
}
int rec_pong_09(int n) {
    volatile char frame[96]; frame[0] = (char)n;
    if (n <= 0) return frame[0];
    return rec_ping_09(n - 1) + frame[0];
}

int rec_cyc_0_1(int n);


int rec_cyc_0_0(int n);
int rec_cyc_0_1(int n);
int rec_cyc_0_2(int n);
int rec_cyc_0_0(int n) {
    volatile char frame[40]; frame[0] = (char)n;
    if (n <= 0) return frame[0];
    return rec_cyc_0_1(n - 1) + frame[0];
}
int rec_cyc_0_1(int n) {
    volatile char frame[48]; frame[0] = (char)n;
    if (n <= 0) return frame[0];
    return rec_cyc_0_2(n - 1) + frame[0];
}
int rec_cyc_0_2(int n) {
    volatile char frame[56]; frame[0] = (char)n;
    if (n <= 0) return frame[0];
    return rec_cyc_0_0(n - 1) + frame[0];
}
int rec_cyc_1_1(int n);


int rec_cyc_1_0(int n);
int rec_cyc_1_1(int n);
int rec_cyc_1_2(int n);
int rec_cyc_1_0(int n) {
    volatile char frame[40]; frame[0] = (char)n;
    if (n <= 0) return frame[0];
    return rec_cyc_1_1(n - 1) + frame[0];
}
int rec_cyc_1_1(int n) {
    volatile char frame[48]; frame[0] = (char)n;
    if (n <= 0) return frame[0];
    return rec_cyc_1_2(n - 1) + frame[0];
}
int rec_cyc_1_2(int n) {
    volatile char frame[56]; frame[0] = (char)n;
    if (n <= 0) return frame[0];
    return rec_cyc_1_0(n - 1) + frame[0];
}
int rec_cyc_2_1(int n);


int rec_cyc_2_0(int n);
int rec_cyc_2_1(int n);
int rec_cyc_2_2(int n);
int rec_cyc_2_0(int n) {
    volatile char frame[40]; frame[0] = (char)n;
    if (n <= 0) return frame[0];
    return rec_cyc_2_1(n - 1) + frame[0];
}
int rec_cyc_2_1(int n) {
    volatile char frame[48]; frame[0] = (char)n;
    if (n <= 0) return frame[0];
    return rec_cyc_2_2(n - 1) + frame[0];
}
int rec_cyc_2_2(int n) {
    volatile char frame[56]; frame[0] = (char)n;
    if (n <= 0) return frame[0];
    return rec_cyc_2_0(n - 1) + frame[0];
}
int recur_root(void) {
    volatile char frame[16]; frame[0] = 0;
    int s = 0;
    s += rec_self_00(5); s += rec_self_19(5);
    s += rec_ping_00(5); s += rec_ping_09(5);
    s += rec_cyc_0_0(5);
    return s + frame[0];
}
