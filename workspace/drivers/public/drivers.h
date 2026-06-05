// drivers/public/drivers.h
#ifndef DRIVERS_H
#define DRIVERS_H

int dispatch_isr(int vec);
int boot_sequence(void);   // startup: only timer + watchdog armed
int main_loop(void);       // runtime: any device IRQ may fire

#endif
