# Pawn Language Service

A maintained and modernized fork of the original **AMXXPawn Language** VS Code extension, originally authored by **KliPPy** (https://github.com/rsKliPPy/amxxpawn-language).

This fork is maintained by **Bogdan Deaconu** and focuses on keeping the extension working on modern VS Code versions while preserving the original behavior and features, now under the name **Pawn Language**.

---

## Features

- Syntax highlighting for Pawn (`.sma`, `.inc`, `.sp`, `.pwn`) with variant-aware parsing
- Support for AMXX, SourcePawn, and SA-MP Pawn (by extension)
- Autocomplete for functions, macros, variables, constants, enums, and enum members
- Signature help and hover docs (includes doc-comments and inline `#define` comments)
- Go to Definition / Peek Definition for functions, variables, macros, enums, and locals
- Find References and CodeLens reference counts
- Inlay hints for parameters and constant values
- Semantic tokens for macros and enum usage
- `#include` / `#tryinclude` parsing, link resolution, and diagnostics
- Formatting: document and on-type indentation
- Compiler integration with `amxxpc` diagnostics and output formatting
- Optional Web API links for default AMXX includes

## Notes

- All Pawn file types use the `Pawn` language mode by default; the server tracks variants by extension (`.sma` = AMXX, `.sp` = SourcePawn, `.pwn` = SA-MP).

---

## Requirements

To compile plugins from VS Code you need an AMXX compiler (`amxxpc`).

You can use the compiler from the official AMX Mod X package, or your own setup.
