# Smahties Plugin

Local semantic code search for GitHub Copilot using the `smahties` MCP stdio server from [smahtutils](https://github.com/scaryrawr/smahtutils).

## What This Plugin Does

`smahties` indexes local code and exposes MCP tools for code retrieval:

- Semantic, keyword, and hybrid code search
- On-demand indexing for files or directories
- Index status and diagnostics
- Listing indexed code units by path, language, and pagination

The plugin includes:

- `.mcp.json` to start the local `smahties` MCP stdio server
- `skills/smahties/SKILL.md` with agent guidance for using the server effectively

## Prerequisites

- Rust with Cargo
- The `smahties` CLI installed from [smahtutils](https://github.com/scaryrawr/smahtutils)
- An OpenAI-compatible embeddings endpoint configured through `$HOME/.wickedsmaht/config.json` or CLI/environment settings supported by `smahties`

Install `smahties` before installing or using this plugin:

```bash
cargo install --git https://github.com/scaryrawr/smahtutils smahties
```

Confirm the binary is available on your `PATH`:

```bash
smahties --help
```

## Installation

```bash
copilot plugin marketplace add scaryrawr/scarypilot
copilot plugin install smahties@scarypilot
```

## Usage Examples

**Search indexed code:**

```text
"Use smahties to find where authentication config is loaded"
"Search this repo for code related to task scheduling"
```

**Refresh indexing:**

```text
"Ask smahties to index the src directory"
```

**Check index status:**

```text
"Show smahties index status for this repository"
```

## Notes

- The plugin starts `smahties` from your `PATH`; install `smahtutils` first or the MCP server cannot start.
- `smahties` stores index state under `.smahties/smahties.sqlite` when running in a Git repository.
- `smahties` skips common expensive or generated paths such as `.git`, `.smahties`, `target`, `node_modules`, `.next`, and `.turbo`.
- Use `smahties` for code discovery and retrieval; use normal file tools for reading or editing known files.

## Resources

- [smahtutils repository](https://github.com/scaryrawr/smahtutils)
- [smahties upstream README](https://github.com/scaryrawr/smahtutils/blob/main/apps/smahties/README.md)
