---
applyTo: "plugins/azure-devops/skills/**/*.mts"
description: "Guidance for executable Azure DevOps helper scripts."
---

# Azure DevOps helper scripts

- Keep these files compatible with direct Node execution on the repo's declared runtime floor: `package.json#engines.node` (`>=22.18.0`).
- Preserve the existing ESM + `.mts` patterns that work with `module: nodenext` and direct script execution.
- Reuse helpers from `plugins/azure-devops/skills/shared/azure-devops.mts` when organization or URL normalization logic overlaps.
- Validate `.mts` changes from the repo root with `npm install` and `npm run typecheck`.
