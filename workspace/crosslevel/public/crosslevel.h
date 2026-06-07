// crosslevel/public/crosslevel.h — functions that call each other across many
// hierarchy levels (skip-level calls, shared hubs/diamonds). Designed to
// exercise the call-graph's focus-anchored hover: a "hub" reached from many
// callers at different depths shows the corridor highlight clearly.
#ifndef CROSSLEVEL_H
#define CROSSLEVEL_H
int xl_root(void);
int xl_alt_root(void);
#endif
