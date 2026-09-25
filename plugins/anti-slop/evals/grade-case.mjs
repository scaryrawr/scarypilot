import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { transform } from "esbuild";

const [id, file] = process.argv.slice(2);

const source = await readFile(file, "utf8");

const { code } = await transform(source, { loader: file.endsWith(".ts") ? "ts" : "js", format: "esm" });

const subject = await import(`data:text/javascript;base64,${Buffer.from(code).toString("base64")}`);

switch (id) {
  case "pre-edit-recovery":
    assert.equal(subject.parseStatus("open"), "open");
    assert.equal(subject.parseStatus("closed"), "closed");

    for (const value of ["pending", null, {}, 1]) {
      assert.throws(() => subject.parseStatus(value));
    }

    break;
  case "post-edit-recovery":
    assert.deepEqual(subject.activeLabels([
      { active: true, label: "a" },
      { active: false, label: "b" },
      { active: true, label: "c" },
    ]), ["a", "c"]);
    assert.deepEqual(subject.activeLabels([]), []);
    break;
  case "renamed-record-guard":
    assert.deepEqual(subject.parsePayload('{"kind":"purchase","amount":2,"extra":true}'), {
      kind: "purchase", amount: 2,
    });

    for (const input of ["null", "[]", "4", "{}", '{"kind":"other","amount":2}',
      '{"kind":"purchase","amount":0}', '{"kind":"purchase","amount":"2"}', "{"]) {
      assert.throws(() => subject.parsePayload(input), `accepted ${input}`);
    }

    break;
  case "legitimate-boundary-check":
    assert.deepEqual(subject.readConfig('{"retries":0,"extra":true}'), { retries: 0 });
    assert.deepEqual(subject.readConfig('{"retries":3}'), { retries: 3 });

    for (const input of ["null", "[]", "1", "{}", '{"retries":-1}',
      '{"retries":1.5}', '{"retries":"2"}', "{"]) {
      assert.throws(() => subject.readConfig(input), `accepted ${input}`);
    }

    break;
  case "unrelated-legacy":
    assert.equal(subject.safeLabel("  Ada  "), "Ada");
    assert.equal(subject.safeLabel("  "), "guest");
    break;
  default:
    throw new Error(`Unknown eval case: ${id}`);
}
