# Upstream provenance

- Source: https://github.com/dmmulroy/anti-slop
- Revision: `c44ef22ca116d0ba62a3ff663a0bd13a3f3fa40b`
- Installed path: `tools/oxlint/anti-slop/`
- Source assets: `skills/install-anti-slop/assets/anti-slop/`
- Intentional deviations:
  - `shared/dictionary-types.ts` checks mapped-type key constraints before
    classifying them as open dictionaries, avoiding false positives for finite
    key unions.

Repository-specific rule enablement and ignore patterns live in the root
`oxlint.config.ts`.
