# TypeScript Native LSP Plugin

High-performance TypeScript/JavaScript language server for GitHub Copilot using Microsoft's [typescript-native](https://github.com/microsoft/typescript-go) (`tsgo`).

## What This Plugin Does

Provides enhanced code intelligence for TypeScript and JavaScript:

- IntelliSense and type information
- Go to definition and find references
- Rename refactoring across files
- Real-time diagnostics and quick fixes

## Installation

1. Install the TypeScript Native language server:

   ```sh
   npm install -g @typescript/native-preview
   ```

2. Install the plugin:

   ```sh
   claude plugin install typescript-native-lsp
   ```

## Supported Extensions

`.ts`, `.tsx`, `.js`, `.jsx`, `.mts`, `.cts`, `.mjs`, `.cjs`

## Usage Examples

**Find references:**

```text
"Find all usages of the authenticate function"
```

**Type-safe refactoring:**

```text
"Rename the UserService class to AccountService"
```

**Code generation:**

```text
"Create a method that accepts a User object and returns a formatted name"
```

## Resources

- [TypeScript Native Repository](https://github.com/microsoft/typescript-go)
