import assert from "node:assert/strict";
import test from "node:test";
import { greeting } from "../src/index.js";

test("greeting preserves the client-facing output format", () => {
  assert.equal(greeting("Copilot"), "Hello, Copilot!");
});
