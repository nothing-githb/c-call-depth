"""Read GCC -fstack-usage (.su) files.

Each .su line looks like:
    path/to/file.c:LINE:COL:funcname    BYTES    qualifier
where qualifier is one of: static, dynamic, dynamic,bounded.

We only need funcname → bytes (and the qualifier, kept for reporting).
"""

from __future__ import annotations

import os
from typing import Optional


class SuEntry:
    __slots__ = ("func", "bytes", "qualifier", "file", "line")

    def __init__(self, func: str, nbytes: int, qualifier: str, file: str, line: int):
        self.func = func
        self.bytes = nbytes
        self.qualifier = qualifier
        self.file = file
        self.line = line


def _split_location(loc: str) -> tuple[str, int, str]:
    """Parse a .su location field 'file:line:col:func' from the RIGHT.

    Returns (file, line, func). Splitting from the right keeps colons that
    belong to the file path (Windows 'C:\\...' drive letters, or ':' in odd
    paths) attached to the file rather than leaking into the name.
    Handles three shapes:
      file:line:col:func   (normal, modern GCC)
      file:line:func       (no column)
      func                 (no location info — last resort)
    """
    parts = loc.rsplit(":", 3)
    if len(parts) == 4 and parts[1].isdigit() and parts[2].isdigit():
        return parts[0], int(parts[1]), parts[3]
    parts = loc.rsplit(":", 2)
    if len(parts) == 3 and parts[1].isdigit():
        return parts[0], int(parts[1]), parts[2]
    parts = loc.rsplit(":", 1)
    if len(parts) == 2:
        return parts[0], 0, parts[1]
    return "", 0, loc


def parse_su_file(path: str) -> list[SuEntry]:
    out: list[SuEntry] = []
    try:
        with open(path, "r", encoding="utf-8", errors="replace") as f:
            for raw in f:
                line = raw.rstrip("\n")
                if not line.strip():
                    continue
                # Split on tabs first; GCC uses tabs between the 3 columns.
                parts = line.split("\t")
                if len(parts) < 2:
                    # Fall back to whitespace split.
                    parts = line.split()
                    if len(parts) < 2:
                        continue
                loc = parts[0]
                try:
                    nbytes = int(parts[1].strip())
                except ValueError:
                    continue
                qualifier = parts[2].strip() if len(parts) > 2 else ""
                # loc = file:line:col:funcname. The function name is the LAST
                # colon-separated field. We split FROM THE RIGHT so a colon in
                # the file path (e.g. a Windows drive letter "C:\...") doesn't
                # shift the fields — that bug made names come out as "16:foo"
                # (column + name) on Windows.
                src, ln, func = _split_location(loc)
                out.append(SuEntry(func, nbytes, qualifier, src, ln))
    except Exception:
        pass
    return out


class SuIndex(dict):
    """A funcname → SuEntry dict that also carries a file-qualified index
    on `.by_file_func`: (source-file stem, funcname) → SuEntry."""
    by_file_func: dict


def scan_su_directory(directory: str) -> "SuIndex":
    """Walk a directory for .su files and return funcname → SuEntry.

    When the same function appears in multiple .su files (rare), the larger
    frame wins — conservative for worst-case stack analysis.

    The returned object also exposes `.by_file_func`: (source-file stem,
    funcname) → SuEntry, so callers can disambiguate same-named statics
    defined in different files (which the name-only map collapses).
    """
    by_name = SuIndex()
    by_file_func: dict[tuple[str, str], SuEntry] = {}
    by_name.by_file_func = by_file_func
    if not directory or not os.path.isdir(directory):
        return by_name
    for dirpath, dirnames, filenames in os.walk(directory):
        dirnames[:] = [d for d in dirnames if d not in (".git", "node_modules")]
        for fn in filenames:
            if fn.endswith(".su"):
                for e in parse_su_file(os.path.join(dirpath, fn)):
                    prev = by_name.get(e.func)
                    if prev is None or e.bytes > prev.bytes:
                        by_name[e.func] = e
                    if e.file:
                        stem = os.path.splitext(os.path.basename(e.file))[0]
                        k = (stem, e.func)
                        kp = by_file_func.get(k)
                        if kp is None or e.bytes > kp.bytes:
                            by_file_func[k] = e
    return by_name
