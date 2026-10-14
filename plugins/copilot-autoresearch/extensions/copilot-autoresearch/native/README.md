# Windows ownership proof — not an execution backend

This is the first native gate for replacing disproven Windows ancestry
cancellation. It is **test-only**, not loaded by the extension or shipped in
`dist/`. The existing runner, waiting Bash, census timing edits, and cancellation
assertions remain unchanged.

The C++ Node-API 8 harness creates an unnamed non-inheritable job with only
`KILL_ON_JOB_CLOSE`, whitelists three NUL stdio handles, and creates the explicit
Unicode executable suspended with `PROC_THREAD_ATTRIBUTE_JOB_LIST`. It verifies
membership before allowing resume. There is no create-then-assign window,
breakaway flag, ancestry scan, taskkill fallback, PowerShell dependency, runtime
compiler, download, or helper lease. The shared Node test host is never assigned
to the owned job.

Allocation/freeing stays inside the addon. JS gets an opaque wrapped resource,
not HANDLEs or fake Node file descriptors. All Node imports must be in the
harness's stable Node-API 8 allowlist; no V8 or private libuv imports are allowed.

## Builder contract

Run from `extensions/copilot-autoresearch` in a Windows MSVC **v143** developer
environment with a Windows 10+ SDK exposing `PROC_THREAD_ATTRIBUTE_JOB_LIST`.
Pin the exact installed MSVC and SDK versions in CI, then pass those pins to the
script. The script fails on an environment/version/target mismatch.

Inputs must already exist; the script does not fetch or install anything:

- Official Node **22.18.0** headers, including `node_version.h`.
- The matching official `win-x64/node.lib` or `win-arm64/node.lib`.
- `cl.exe`, `link.exe`, and `dumpbin.exe` from the selected MSVC toolchain.
- Windows SDK headers/libraries for the selected target.

The official Node inputs are under
`https://nodejs.org/dist/v22.18.0/`: `node-v22.18.0-headers.tar.gz`,
`win-x64/node.lib`, and `win-arm64/node.lib`. Any CI download is an explicit
workflow preparation step; pin/verify those downloads against the official
`SHASUMS256.txt`. Nothing is downloaded on plugin-user machines.

For x64, select the `x64` developer target. For an ARM64 cross-build on an x64
builder, select `x64_arm64` (`VSCMD_ARG_TGT_ARCH=arm64`). Native ARM64 builders can
use their corresponding ARM64 developer target.

```powershell
node native/build-harness.mjs --arch x64 `
  --node-include "<node-v22.18.0>\include\node" `
  --node-lib "<downloaded win-x64>\node.lib" `
  --expect-msvc "<pinned VCToolsVersion>" --expect-sdk "<pinned WindowsSDKVersion>"

node native/build-harness.mjs --arch arm64 `
  --node-include "<node-v22.18.0>\include\node" `
  --node-lib "<downloaded win-arm64>\node.lib" `
  --expect-msvc "<pinned VCToolsVersion>" --expect-sdk "<pinned WindowsSDKVersion>"
```

Switch the developer environment between the two commands. No Zig toolchain is
needed when Windows CI provides MSVC and both target libraries.

The build uses `/MT`, `/W4 /WX`, `NAPI_VERSION=8`, and explicit PE machine targets.
Flags alone do not prove runtime independence: the script runs `dumpbin /imports`
and rejects VC++/UCRT DLLs, non-system DLLs, and non-Node-API imports from
`node.exe`. An unexpected import or unsupported dumpbin format is a failed gate,
not grounds to widen the allowlist silently.

`harness-resources.json` is the one resource inventory. Output per architecture:

```text
native/artifacts/win32-{x64,arm64}/
  ownership-harness.node
  provenance.json
  imports.txt
  dependents.txt
  compile.txt
```

CI may upload those directories with `actions/upload-artifact` for this draft
proof. No release publication is authorized. The future installed plugin will
ship reviewed offline prebuilds; these test artifacts are not that release.

Provenance records the raw-byte SHA256 and size of the PE binary, raw-byte source
fingerprints, Node headers/import-library hashes, exact toolchain versions, and
audited imports. Native input changes require a rebuild. This verifier rejects a
binary whose bytes, architecture, imports, or current source fingerprint differ:

```powershell
node native/verify-artifact.mjs x64
node native/verify-artifact.mjs arm64
```

## Native proof gate

Cross-compilation is not execution proof. Run **each** artifact on its matching
native Windows hardware/VM with matching Node architecture; x64 emulation on ARM64
does not count as the x64 native gate. Test both Node 22.18.0 and a newer supported
Node against the same artifact to exercise the stable ABI.

```powershell
$env:OWNERSHIP_EXPECT_ARCH = "x64" # "arm64" on the native ARM64 runner
$env:OWNERSHIP_BASH_EXE = "<resolved Git-for-Windows bash.exe>"
npm run native:harness:test
```

The suite refuses non-Windows or wrong-machine execution, verifies the raw binary
hash/source provenance before loading, and records Node/Bash architecture.
Cases cover:

- Atomic suspended membership, no inherited job handle or breakaway permissions,
  pre-resume stop, idempotent stop, and already-cancelled preparation.
- Real Git-for-Windows Bash plus native Node parent/grandchild membership, the
  unchanged **1500 ms ready / 1800 ms timeout / late marker** requirements, and
  job-accounting confirmation of zero members.
- Repeated forced host death at test-only barriers immediately before creation
  and after atomic creation but before membership verification/resume.
- Abrupt running-host death, nested jobs, two independent jobs plus an unrelated
  control, legitimate native root statuses (including 259), Unicode inputs, and
  stage-labelled errors.
- Logical Bash status across command, script, and explicit `exec` forms.
  `OWNERSHIP_HARNESS_READY` includes the root's status at descendant readiness;
  `OWNERSHIP_HARNESS_BASH_STATUS` compares expected/actual command status. An MSYS
  replacement stub reporting an early or wrong root status blocks integration;
  job emptiness is not a substitute for the logical command's exit status.

Cross-platform build-spec tests do **not** prove Win32 behavior:

```sh
npm run native:harness:check
```

## Deliberately not implemented

This bounded harness uses NUL stdio and synchronous, bounded test methods.
Production stream transport, backpressure, asynchronous creation/cancellation
serialization, host cleanup hooks, loader/distribution integration, and runner
replacement are not implemented or validated. Existing capture/logging stays in
Node. Do not promote the harness's public fault stages into a runtime API.

First obtain pinned-commit native x64/ARM64 proof and import audits. If creation,
nested-job policy, cold readiness, or host-death ownership fails, report that
friction and revisit the shape. Do not add post-create assignment, breakaway,
ancestry fallbacks, initialization exemptions, or weaker timing assertions.
