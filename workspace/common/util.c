// common/util.c
#include "common/util.h"

static int util_helper0(int x) {
    volatile char _buf[64]; _buf[0] = 0;
    return x + _buf[0] + 0;
}

static int util_helper1(int x) {
    volatile char _buf[32]; _buf[0] = 0;
    return x + _buf[0] + 1;
}

static int util_helper2(int x) {
    volatile char _buf[32]; _buf[0] = 0;
    return x + _buf[0] + 2;
}

static int util_helper3(int x) {
    volatile char _buf[32]; _buf[0] = 0;
    return x + _buf[0] + 3;
}

static int util_helper4(int x) {
    volatile char _buf[128]; _buf[0] = 0;
    return x + _buf[0] + 4;
}

int util_compute(int x) {
    volatile char _buf[64]; _buf[0] = 0;
    int r = 0;
    r += util_helper0(x);
    r += util_helper1(x);
    r += util_helper2(x);
    r += util_helper3(x);
    r += util_helper4(x);
    (void)util_hub();
    return r + _buf[0];
}

int util_hub(void) {
    volatile char _buf[48]; _buf[0] = 0;
    return _buf[0];
}

