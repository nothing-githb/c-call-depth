CC := gcc
CFLAGS := -O0 -Wall -fstack-usage -fdump-rtl-expand -I.
BUILD := build
SRCS := $(shell find modules common deep app drivers fpkinds deepchain recur manyfp peakverify fpadvanced fpstruct longcycle -name '*.c')
OBJS := $(patsubst %.c,$(BUILD)/%.o,$(SRCS))

all: $(OBJS)
	@echo "Built $(words $(OBJS)) object files."

$(BUILD)/%.o: %.c
	@mkdir -p $(dir $@)
	$(CC) $(CFLAGS) -c $< -o $@

clean:
	rm -rf $(BUILD)

compile_commands.json:
	@echo '[' > $@
	@first=1; for f in $(SRCS); do \
	  if [ $$first -eq 0 ]; then echo "," >> $@; fi; \
	  first=0; \
	  printf '  { "directory": "%s", "file": "%s", "command": "$(CC) $(CFLAGS) -c %s" }' "$(PWD)" "$$f" "$$f" >> $@; \
	done
	@echo '' >> $@
	@echo ']' >> $@

.PHONY: all clean compile_commands.json
