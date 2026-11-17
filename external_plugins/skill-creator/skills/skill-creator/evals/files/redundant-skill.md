---
name: redundant-skill
description: Normalize messy CSV exports into UTF-8 CSV files when asked to clean exported tabular data.
---

# CSV Normalization

Normalize messy CSV exports into UTF-8 CSV files when asked to clean exported tabular data.

## When to use

Use for cleaning CSV exports.

## Use this for

Use for normalizing messy tabular exports.

## Trigger examples

"Clean this CSV export" and "Normalize this CSV file".

## Workflow

1. Detect the input delimiter and encoding; ask when ambiguous.
2. Trim surrounding header whitespace and remove a leading byte-order mark.
3. Write UTF-8 comma-delimited CSV, preserving quoted newlines and cell values.
4. Report rows written and any malformed records. Never overwrite the source.
