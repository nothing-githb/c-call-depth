// drivers/src/drivers.c
#include "drivers/public/drivers.h"
#include "common/util.h"

static int timer_read_status(void) {
    volatile char _buf[16]; _buf[0] = 0;
    return _buf[0];
}

static int timer_clear_flags(void) {
    volatile char _buf[48]; _buf[0] = 0;
    return _buf[0] + timer_read_status();
}

int isr_timer(void) {
    volatile char _buf[128]; _buf[0] = 0;
    (void)timer_clear_flags();
    (void)util_hub();
    return _buf[0];
}

static int watchdog_read_status(void) {
    volatile char _buf[16]; _buf[0] = 0;
    return _buf[0];
}

static int watchdog_clear_flags(void) {
    volatile char _buf[16]; _buf[0] = 0;
    return _buf[0] + watchdog_read_status();
}

int isr_watchdog(void) {
    volatile char _buf[192]; _buf[0] = 0;
    (void)watchdog_clear_flags();
    (void)util_hub();
    return _buf[0];
}

static int uart_read_status(void) {
    volatile char _buf[32]; _buf[0] = 0;
    return _buf[0];
}

static int uart_clear_flags(void) {
    volatile char _buf[48]; _buf[0] = 0;
    return _buf[0] + uart_read_status();
}

int isr_uart(void) {
    volatile char _buf[64]; _buf[0] = 0;
    (void)uart_clear_flags();
    (void)util_hub();
    return _buf[0];
}

static int spi_read_status(void) {
    volatile char _buf[32]; _buf[0] = 0;
    return _buf[0];
}

static int spi_clear_flags(void) {
    volatile char _buf[16]; _buf[0] = 0;
    return _buf[0] + spi_read_status();
}

int isr_spi(void) {
    volatile char _buf[128]; _buf[0] = 0;
    (void)spi_clear_flags();
    (void)util_hub();
    return _buf[0];
}

static int i2c_read_status(void) {
    volatile char _buf[32]; _buf[0] = 0;
    return _buf[0];
}

static int i2c_clear_flags(void) {
    volatile char _buf[16]; _buf[0] = 0;
    return _buf[0] + i2c_read_status();
}

int isr_i2c(void) {
    volatile char _buf[128]; _buf[0] = 0;
    (void)i2c_clear_flags();
    (void)util_hub();
    return _buf[0];
}

static int dma_read_status(void) {
    volatile char _buf[16]; _buf[0] = 0;
    return _buf[0];
}

static int dma_clear_flags(void) {
    volatile char _buf[32]; _buf[0] = 0;
    return _buf[0] + dma_read_status();
}

int isr_dma(void) {
    volatile char _buf[512]; _buf[0] = 0;
    (void)dma_clear_flags();
    (void)util_hub();
    return _buf[0];
}

static int eth_read_status(void) {
    volatile char _buf[32]; _buf[0] = 0;
    return _buf[0];
}

static int eth_clear_flags(void) {
    volatile char _buf[48]; _buf[0] = 0;
    return _buf[0] + eth_read_status();
}

int isr_eth(void) {
    volatile char _buf[768]; _buf[0] = 0;
    (void)eth_clear_flags();
    (void)util_hub();
    return _buf[0];
}

static int usb_read_status(void) {
    volatile char _buf[32]; _buf[0] = 0;
    return _buf[0];
}

static int usb_clear_flags(void) {
    volatile char _buf[48]; _buf[0] = 0;
    return _buf[0] + usb_read_status();
}

int isr_usb(void) {
    volatile char _buf[1024]; _buf[0] = 0;
    (void)usb_clear_flags();
    (void)util_hub();
    return _buf[0];
}

typedef int (*isr_fn_t)(void);

static isr_fn_t vector_table[8] = {
    isr_timer,
    isr_watchdog,
    isr_uart,
    isr_spi,
    isr_i2c,
    isr_dma,
    isr_eth,
    isr_usb,
};

int dispatch_isr(int vec) {
    volatile char _buf[64]; _buf[0] = 0;
    if (vec < 0 || vec >= 8) return -1;
    isr_fn_t fn = vector_table[vec];
    return fn() + _buf[0];   // <-- indirect call (fp name: fn)
}

int boot_sequence(void) {
    volatile char _buf[96]; _buf[0] = 0;
    int r = 0;
    r += dispatch_isr(0);   // timer
    r += dispatch_isr(1);   // watchdog
    return r + _buf[0];
}

int main_loop(void) {
    volatile char _buf[96]; _buf[0] = 0;
    int r = 0;
    for (int v = 0; v < 8; v++) r += dispatch_isr(v);
    return r + _buf[0];
}

