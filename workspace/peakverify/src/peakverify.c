// peakverify/src/peakverify.c — hand-computable peaks (generated)
#include "peakverify/public/peakverify.h"

int pv_lin0(int x) {
    volatile char frame[256]; frame[0] = (char)x;
    return pv_lin1(x) + frame[0];
}

int pv_lin1(int x) {
    volatile char frame[512]; frame[0] = (char)x;
    return pv_lin2(x) + frame[0];
}

int pv_lin2(int x) {
    volatile char frame[768]; frame[0] = (char)x;
    return pv_lin3(x) + frame[0];
}

int pv_lin3(int x) {
    volatile char frame[1024]; frame[0] = (char)x;
    return pv_lin4(x) + frame[0];
}

int pv_lin4(int x) {
    volatile char frame[1280]; frame[0] = (char)x;
    return pv_lin5(x) + frame[0];
}

int pv_lin5(int x) {
    volatile char frame[1536]; frame[0] = (char)x;
    return frame[0];
}

int pv_light_leaf(int x) { volatile char b[128]; b[0]=(char)x; return b[0]; }
int pv_heavy_mid(int x)  { volatile char b[2048]; b[0]=(char)x; return pv_lin0(x) + b[0]; }
int pv_branch(int x) {
    volatile char frame[512]; frame[0] = (char)x;
    return pv_light_leaf(x) + pv_heavy_mid(x) + frame[0];
}

int pv_bottom(int x) { volatile char b[1024]; b[0]=(char)x; return b[0]; }
int pv_left(int x)   { volatile char b[256];  b[0]=(char)x; return pv_bottom(x) + b[0]; }
int pv_right(int x)  { volatile char b[768];  b[0]=(char)x; return pv_bottom(x) + b[0]; }
int pv_top(int x) {
    volatile char frame[256]; frame[0] = (char)x;
    return pv_left(x) + pv_right(x) + frame[0];
}
