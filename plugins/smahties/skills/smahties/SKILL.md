---
name: smahties
description: Use the local smahties MCP server when users ask for semantic code search, conceptual codebase discovery, keyword or hybrid code search, indexing files/directories, checking index status, or listing indexed code units.
---

# Smahties Skill

Use this skill when the user asks to search, explore, or index local code with `smahties`, especially when semantic code retrieval is more useful than exact text matching.

## Prerequisites

The `smahties` binary must already be installed from [smahtutils](https://github.com/scaryrawr/smahtutils) and available on `PATH`. If the MCP server fails to start because `smahties` is missing, tell the user to install it first:

```bash
cargo install --git https://github.com/scaryrawr/smahtutils smahties
```

`smahties` also needs an OpenAI-compatible embeddings endpoint, usually configured in `$HOME/.wickedsmaht/config.json`.

## When to use smahties

- Use `query_code` for semantic, keyword, or hybrid searches across indexed code.
- Use `index_path` when the user asks to index or refresh a specific file or directory.
- Use `status` to check root, queue counts, store stats, recent errors, and indexer state.
- Use `list_indexed` to inspect indexed code units by path, language, limit, or source inclusion.

## Workflow

1. Check `status` when index freshness or server health matters.
2. Use `index_path` before searching newly added or recently changed paths.
3. Use `query_code` for broad code-discovery questions such as "where is this behavior implemented?"
4. Use `list_indexed` when the user asks what code is indexed or needs a scoped inventory.
5. After finding candidate files, read exact files with normal file tools before editing.

If MCP tools are not exposed in the current agent environment but the `smahties` CLI is available, use the equivalent CLI commands from the repository root: `smahties --root . status`, `smahties --root . index <path>`, `smahties --root . query --mode hybrid "<query>"`, and `smahties --root . list-indexed`. Put global flags such as `--root` before the subcommand.

## Search guidance

- Prefer semantic or hybrid search for conceptual questions.
- Prefer keyword search for exact identifiers, literals, or error text.
- Scope searches by root/path when the user names a specific subsystem.
- Do not treat retrieved snippets as complete context for code changes; open the source files before modifying them.

## Safety

Do not log or expose source snippets, embeddings, model responses, API settings, or secrets beyond what is needed to answer the user. Indexing writes local state under `.smahties/` in Git repositories.
