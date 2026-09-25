export default {
  entry: ["src/extension.ts"],
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
