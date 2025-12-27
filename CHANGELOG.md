# Changelog

All notable changes to this project will be documented in this file.

This project is a maintained and modernized fork of the original
**AMXXPawn Language** extension, originally created by **KliPPy**.

This fork is currently maintained and updated by **Bogdan Deaconu**.

---

## [Version 1.0.0] - 2025-12-27

### Added
- Modernized extension to work with current VS Code versions (2024+)
- Updated Language Server and Client to the latest stable APIs
- Proper support for `${workspaceFolder}` in:
  - compiler executable paths
  - include paths
  - output paths
- Correct handling of workspace folders (multi-root and debug host compatible)
- Improved diagnostics and detailed logging during compilation
- Extra language settings for fine-grained control over:
  - inlay hints
  - hover details
  - enum highlighting
- Per-feature settings toggles for language server features, including:
  - go to definition
  - find references
  - CodeLens
  - inlay hints
  - hover
  - completions
  - formatting
  - semantic macro highlighting
- Go to definition for:
  - non-public and local functions
  - macros (`#define`), enums, const, new const, and variables declared in multi-line lists
  - local variables and function parameters
- References and CodeLens:
  - reference counts displayed above declarations
  - direct jump to the single reference when only one exists
- Parameter inlay hints for:
  - function calls
  - natives
  - stocks
  - macros
- Hover improvements:
  - display constant values
  - show inline `//` comments for `#define`
  - prevent doc-comment bleed into unrelated symbols
  - local hover support for constants and variables
- Enum usage highlighting inside `[]`
- Macro highlighting via semantic tokens
- Smarter handling of `#define` aliases versus const-like macros
- More robust parsing of array and struct initializers
- Auto-indent support (document formatting and on-type).
- Inline define value hints for numeric and string defines

### Changed
- Upgraded TypeScript to a modern version
- Updated `vscode-languageclient` and `vscode-languageserver`
- Replaced deprecated VS Code APIs (`workspace.rootPath`, legacy imports)
- Refactored extension lifecycle handling (proper Language Client start and stop)
- Improved internal path resolution logic for better robustness

---

## [Version 0.7.0] - 2018-03-01
### Added
- Go to Definition/Peek Definition for functions and global variables
- All tags are now highlighted, not just predefined ones
- Tag lists are now highlighted
- Tag highlighting works properly in ternary operators
- Doc-comments are now displayed on signature help/hover/completions
- Pawndoc grammar - doc-comments are highlighted separately

---

## [Version 0.6.3] - 2018-02-23
### Added
- Marketplace icon and banner
- `//#region` and `//#endregion`

### Fixed
- Automatically switches to AMXXPawn if there's `#include <amxmodx>` on the first code line

---

## [Version 0.6.0] - 2018-02-22
### Added
- Syntax highlight for "forward" keyword
- Fuzzy search for completions

### Changed
- Doesn't append `'('` and `'()'` on function autocompletions anymore
- Syntax highlight improvements
- `'^'` is now the string escape character

### Fixed
- Symbols starting with `'@'` weren't being parsed
- Included files that are local to the source file weren't being resolved correctly

---

## [Version 0.5.0] - 2017-08-31
### Added
- Syntax highlight for "native" keyword
- Append `'('` (or `'()'` if function has no arguments) on function autocompletion
- Hover information when hovering over functions, variables and constants
- `amxxpawn.compiler.reformatOutput` - reformats compiler output to clear unimportant information and remove clutter
- Compiler warnings and errors get turned into diagnostics

### Changed
- Syntax highlight now highlights only known tags from AMXX
- Completion search is now case-insensitive
- `amxxpawn.language.webApiLinks` and `amxxpawn.compiler.showInfoMessages` are now false by default

---

## [Version 0.4.0] - 2017-08-29
### Added
- Suggestions/completions for variables and constants
- Diagnostics for variable/constant definitions
- `amxxpawn.compiler.showInfoMessages` setting

### Fixed
- Highlighting for `[]` and `()` pairs
- Correct CWD when running amxxpc

---

## [Version 0.3.1] - 2017-08-27
### Added
- Reparse open documents when configuration changes

### Fixed
- Variable substitution in `includePaths`

---

## [Version 0.3.0] - 2017-08-27
### Added
- Substitution variables allowed in path settings
- More diagnostics for `#include` statements

### Fixed
- Correct character ranges for include diagnostics

---

## [Version 0.2.1] - 2017-08-27
### Added
- Support for `#tryinclude` without hard errors
- Diagnostics for unmatched closing braces

### Fixed
- Include resolution bugs
- Multiline comment parsing issues

---

## [Version 0.2.0] - 2017-08-25
### Added
- Document symbol lookup (`Ctrl+Shift+O`)
- Symbol completion

### Fixed
- Dependency management memory leaks

---

## [Version 0.1.0] - 2017-08-25
### Added
- Compile Plugin Local command

---

## [Version 0.0.5] - 2017-08-25
### Fixed
- `outputType === 'path'`
- Output panel focus on compilation

---

## [Version 0.0.4] - 2017-08-25
### Fixed
- Parser issues with whitespaces

---

## [Version 0.0.3] - 2017-08-25
### Fixed
- Crash when parsing functions without storage specifiers

---

## [Version 0.0.1] - 2017-08-25
- Initial release
