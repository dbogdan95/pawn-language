# AMXXPawn Language Service

A maintained and modernized fork of the original **AMXXPawn Language** VS Code extension, originally authored by **KliPPy**.

This fork is maintained by **Bogdan Deaconu** and focuses on keeping the extension working on modern VS Code versions while preserving the original behavior and features.

---

## Features

- Syntax highlighting for AMXX Pawn (`.sma`, `.inc`)
- Autocomplete for functions, variables, and constants
- Hover documentation and signature help (including doc-comments)
- Go to Definition / Peek Definition for functions and global variables
- Diagnostics from `amxxpc` warnings and errors
- `#include` / `#tryinclude` parsing, linking, and diagnostics
- Optional Web API links for default AMXX includes

---

## Requirements

To compile plugins from VS Code you need an AMXX compiler (`amxxpc`).

You can use the compiler from the official AMX Mod X package, or your own setup.