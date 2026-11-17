import { cacheHome } from "./codex.mjs";
import { oxlintExecutable } from "./oxlint-runtime.mjs";

console.log(await oxlintExecutable({ cacheHome, install: true }));
