export default {
  entry: { extension: "src/extension.ts", cli: "src/run-cli.ts" },
  clean: true,
  deps: {
    alwaysBundle: [/^@sinclair\/typebox(?:\/|$)/],
    neverBundle: [/^@github\/copilot-sdk(?:\/|$)/],
  },
  format: ["esm"],
  minify: true,
  outDir: "dist",
  platform: "node",
  target: "node22",
};
