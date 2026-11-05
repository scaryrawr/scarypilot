# Upstream provenance

- Source: https://github.com/dmmulroy/anti-slop
- Revision: `13909c9e07590f5a85d93c62712259fe14a883f7`
- Installed path: `tools/oxlint/anti-slop/`
- Source assets: `skills/install-anti-slop/assets/anti-slop/`
- Intentional deviations:
  - `shared/dictionary-types.ts` checks mapped-type key constraints before
    classifying them as open dictionaries, avoiding false positives for finite
    key unions.

Repository-specific rule enablement and ignore patterns live in the root
`oxlint.config.ts`.
