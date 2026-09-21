import { defineConfig } from "oxlint";

export default defineConfig({
  ignorePatterns: [
    ".agent/**",
    ".agents/**",
    ".claude/**",
    ".codex/**",
    ".continue/**",
    ".cursor/**",
    ".gemini/**",
    ".opencode/**",
    ".pi/**",
    ".roo/**",
    ".windsurf/**",
    "**/build/**",
    "**/coverage/**",
    "**/dist/**",
    "**/out/**",
    "plugins/azure-devops/extensions/paired-review/public/**",
    "tools/oxlint/anti-slop/**",
  ],
  jsPlugins: [
    {
      name: "anti-slop",
      specifier: "./tools/oxlint/anti-slop/index.ts",
    },
  ],
  rules: {
    "oxc/no-accumulating-spread": "error",
    "anti-slop/no-array-filter-map": "error",
    "anti-slop/no-reduce-accumulator-copy": "error",
    "anti-slop/no-chained-type-assertions": "error",
    "anti-slop/no-conditional-empty-object-spread": "error",
    "anti-slop/no-known-value-widening": "error",
    "anti-slop/no-module-mocking": "error",
    "anti-slop/no-object-parameters": "error",
    "anti-slop/no-reflect-apply": "error",
    "anti-slop/no-reflect-get": "error",
    "anti-slop/no-runtime-typeof": "off",
    "anti-slop/no-shape-in-symbol-names": "error",
    "anti-slop/no-unknown-parameters": "error",
    "anti-slop/no-unknown-returns": "error",
    "anti-slop/no-unknown-type-aliases": "error",
    "anti-slop/no-unsafe-dictionary-type": "error",
    "anti-slop/no-widen-then-assert": "error",
    "anti-slop/require-readable-spacing": "error",
    "anti-slop/require-safety-comment-for-type-assertion": "error",
  },
  overrides: [
    {
      files: [
        "**/*client.{ts,tsx,js,mjs,cjs}",
        "**/*loader.{ts,tsx,js,mjs,cjs}",
        "**/*reader.{ts,tsx,js,mjs,cjs}",
        "**/*parser.{ts,tsx,js,mjs,cjs}",
        "**/providers/**/*.{ts,tsx,js,mjs,cjs}",
        "**/jsonl.{ts,tsx,js,mjs,cjs}",
        "**/state.{ts,tsx,js,mjs,cjs}",
      ],
      rules: {
        "anti-slop/no-runtime-typeof": [
          "error",
          { allowInTypeGuards: true },
        ],
      },
    },
    {
      files: [
        "**/skills/**/scripts/**/*.{js,mjs,cjs,ts,mts,cts}",
      ],
      rules: {
        "anti-slop/no-runtime-typeof": "off",
        "anti-slop/no-unknown-parameters": "off",
        "anti-slop/no-unknown-returns": "off",
        "anti-slop/no-unsafe-dictionary-type": "off",
      },
    },
  ],
});
