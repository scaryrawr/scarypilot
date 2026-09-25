import generic from "./oxlint.config.mjs";

export default {
  ...generic,
  jsPlugins: [
    ...generic.jsPlugins,
    { name: "anti-slop-effect", specifier: "./dist/anti-slop-effect.mjs" },
  ],
  rules: {
    ...generic.rules,
    "anti-slop-effect/no-manual-effect-error-tag": "error",
    "anti-slop-effect/no-manual-tag-comparison": "error",
    "anti-slop-effect/no-manual-tagged-construction": "error",
    "anti-slop-effect/no-service-constructor-imports": "error",
    "anti-slop-effect/prefer-effect-match": "error",
  },
};
