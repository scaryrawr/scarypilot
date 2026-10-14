import { afterEach, expect, it, vi } from "vitest";
import { openConfinedFile, validateWorkspaceFilePath } from "../src/workspace-reader.ts";

afterEach(() => vi.unstubAllGlobals());

it.each([
  "", " ", "../secret", "dir/../secret", "..\\secret", "file:///secret",
  "https://example.invalid/file", "//server/file", "secret\0",
])("rejects invalid path %j before filesystem access on every platform", (path) => {
  expect(() => validateWorkspaceFilePath(path)).toThrow(
    "path must name one workspace file, without URLs or traversal",
  );
});

it("never attempts a native open on unsupported Windows", async () => {
  vi.stubGlobal("process", { ...process, platform: "win32" });
  const openFile = vi.fn();

  await expect(openConfinedFile("C:\\workspace\\file", openFile)).rejects.toThrow(
    "native workspace-confined validation requires macOS or Linux",
  );
  expect(openFile).not.toHaveBeenCalled();
});
