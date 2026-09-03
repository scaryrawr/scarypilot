import { defineConfig } from "tsdown";

export default defineConfig({
  entry: ["src/extension.ts"],
  clean: true,
  deps: {
    alwaysBundle: ["diff", /^@sinclair\/typebox(?:\/|$)/],
    neverBundle: [/^@github\/copilot-sdk(?:\/|$)/],
  },
  format: ["esm"],
  minify: true,
  outDir: "dist",
  platform: "node",
  target: "node24",
});
