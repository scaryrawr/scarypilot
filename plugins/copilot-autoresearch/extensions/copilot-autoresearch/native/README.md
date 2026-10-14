# Windows owned execution and native proof

Windows execution uses an offline Node-API 8 addon backed by an unnamed kernel
job. The production entry is `runtime/owned_job_runtime.cc`; the separate
**test-only** entry is `harness/owned_job_harness.cc`. Both include the same
`shared/owned_job.h` ownership engine. Harness artifacts and fault APIs are never
loaded by the extension or installed in `dist/`.

The engine creates an unnamed non-inheritable job with only
`KILL_ON_JOB_CLOSE`, whitelists exactly three stdio handles, and creates the explicit
Unicode executable suspended with `PROC_THREAD_ATTRIBUTE_JOB_LIST`. It verifies
membership before allowing resume. There is no create-then-assign window,
breakaway flag, ancestry scan, taskkill fallback, PowerShell dependency, runtime
compiler, download, or helper lease. The shared Node test host is never assigned
to the owned job.

Allocation/freeing stays inside the addon. JS gets an opaque wrapped resource,
not HANDLEs or fake Node file descriptors. All Node imports must be in the
stable Node-API 8 allowlist; no V8 or private libuv imports are allowed.

## Production transport

`src/execution.ts` is the private typed boundary shared by both capture runners.
`src/windows-execution.ts` selects by **`process.arch`**, verifies the binary's
raw hash, size, architecture and provenance index, checks the Node-API/protocol
versions, and wraps native operations in genuine Node `Readable`/`Writable`
streams. Missing or inconsistent resources fail closed with reinstall guidance.
There is no compiler, download, ancestry kill, or alternate shell fallback.
The physical/non-emulation architecture check below is **CI proof only**;
x64 Node running on Windows ARM64 is not prohibited at runtime.

Transport uses private anonymous Win32 pipes and dedicated native I/O threads,
rather than named overlapped pipes. Only child stdio ends are inherited; the
sole job handle and all parent pipe ends remain private. No HANDLE is passed as
a Node fd, and no shared Node filesystem worker-pool thread blocks on a pipe.
Creation, root waiting, stop and cleanup run on a separate lifecycle thread.
The Node thread only validates/copies bounded payloads and receives completions.

Protocol 2 sends typed notifications through the public Node-API thread-safe
callback. The shared `src/native-run.ts` client owns all promises and credit
resolvers in JavaScript; the addon never allocates `napi_deferred` handles.
Environment teardown can therefore discard notifications without attempting
prohibited JS calls or abandoning opaque native promise allocations. The native
runtime proof uses this same client (Node 22.18+ built-in test-only type stripping);
the installed extension bundles it as ordinary JavaScript.

Each channel has one outstanding request, read/write chunks are at most 64 KiB,
and the thread-safe completion queue holds at most eight records. Node readable
high-water marks stop further native reads. Writable chunks are acknowledged
sequentially before EOF. JSON input is serialized before starting an experiment.
Output capture, tail policy and overflow files remain owned by `spawn.ts`.
Cancellation is latched and serialized with resume; neither repeated stop nor
resource disposal creates an ancestry recovery path.

Normal root exit records its full DWORD status before stopping remaining job
members. Only stdout and stderr participate in the five-second output drain:
stdin may still be waiting for another write/EOF credit and is cancelled during
I/O shutdown, never a prerequisite for requesting that shutdown. Interrupted or
queued non-cancelled input writes remain failures rather than successful receipts.
Failure/discard stops
capture, closes and removes unreturned logs, cancels I/O, and confirms completion
with another five-second deadline. Cleanup failures retain their stage, Win32
code and known root PID; no error becomes a successful `killed` result.
Successful completion is delivered only after I/O threads join and private
kernel handles close.
If Windows cannot complete synchronous I/O cancellation even after job endpoint
closure, the execution receipt rejects but the engine retains live request memory and thread ownership
until actual completion rather than freeing it unsafely. Such a kernel/driver
failure can prevent host shutdown; restarting the host is recovery, not a
claimed successful bounded cleanup. Real Worker teardown is a native CI gate.

## Builder contract

Run from `plugins/copilot-autoresearch/extensions/copilot-autoresearch` in a Windows MSVC **v143** developer
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
node native/build-harness.mjs --kind runtime --arch x64 `
  --node-include "<node-v22.18.0>\include\node" `
  --node-lib "<downloaded win-x64>\node.lib" `
  --expect-msvc "<pinned VCToolsVersion>" --expect-sdk "<pinned WindowsSDKVersion>"

node native/build-harness.mjs --kind runtime --arch arm64 `
  --node-include "<node-v22.18.0>\include\node" `
  --node-lib "<downloaded win-arm64>\node.lib" `
  --expect-msvc "<pinned VCToolsVersion>" --expect-sdk "<pinned WindowsSDKVersion>"
```

Switch the developer environment between the two commands. Repeat both commands
with `--kind harness` to rebuild the proof addon from the same shared source.
Omitting `--kind` retains the harness builder's original behavior. Build work
directories are separated by kind and architecture. No Zig toolchain is needed
when Windows CI provides MSVC and both target libraries.

The build uses `/MT`, `/W4 /WX`, `NAPI_VERSION=8`, and explicit PE machine targets.
Flags alone do not prove runtime independence: the script runs `dumpbin /imports`
and rejects VC++/UCRT DLLs, non-system DLLs, and non-Node-API imports from
`node.exe`. An unexpected import or unsupported dumpbin format is a failed gate,
not grounds to widen the allowlist silently.

`resources.mjs` is the authoritative discoverable resource interface. It scans
the complete native source tree, excluding only generated `artifacts`,
`prebuilds`, `build`, and `test-work` directories configured in
`harness-resources.json`; symlinks cannot bypass provenance. There is no
hand-maintained source-file list. Raw bytes matter, including source newlines:
builders, native runners and assembly must check out identical source bytes.
Output per architecture:

```text
native/prebuilds/win32-{x64,arm64}/  # runtime
  owned-job.node
  provenance.json
  imports.txt
  dependents.txt
  compile.txt
```

Harness output has the same metadata files under
`native/artifacts/win32-{x64,arm64}/`, with `ownership-harness.node`.
CI may upload these directories with `actions/upload-artifact` for draft proof
and maintainer assembly. No release publication is part of this build.

Provenance records the raw-byte SHA256 and size of the PE binary, raw-byte source
fingerprints, Node headers/import-library hashes, exact toolchain versions, and
audited imports. Native input changes require a rebuild. This verifier rejects a
binary whose bytes, architecture, imports, or current source fingerprint differ:

```powershell
node native/verify-artifact.mjs x64 native/prebuilds/win32-x64 runtime
node native/verify-artifact.mjs arm64 native/prebuilds/win32-arm64 runtime
```

`node native/resources.mjs` (or imported `resources()`) returns
`{schemaVersion,nodeApiVersion,protocolVersion,sources,inputs,targets,outputs}`.
Paths in `inputs`/`outputs` are extension-relative. Each target declares kind,
architecture, PE machine, builder directory, installed directory, entry, binary
and complete file list. `sources` fingerprints native source bytes only;
`inputs` contains only those discovered source files, all intended for version
control. `dist/native/` is the checked-in distribution source of truth.
`native/prebuilds/` is an ignored, disposable build/CI cache, never a required
shared-checker input. Shared freshness tooling should consume the descriptor's
source inputs and require every declared installed output.

The read-only `verifyInstalledResources()` export from `native/assemble.mjs`
verifies both installed artifact sets, every declared resource, and
`dist/native/resources.json` against the current source inventory without needing
any cache.
It returns the verified index:
`{schemaVersion,nodeApiVersion,protocolVersion,sourceFingerprint,binaries}`.
Assembly and validation share the same expected-index constructor, so callers
must not reconstruct this index themselves. Importing the module never assembles
or writes files; only direct CLI execution assembles.

The optional `installedDirectory` argument selects another installed artifact
directory containing `win32-x64/`, `win32-arm64/`, and `resources.json`. Its default
derives from the current inventory. If `prebuildsDirectory` is explicitly supplied,
the validator additionally verifies both cached artifacts and requires
byte-identical copies of all declared resource files. It never hydrates or writes.
Source provenance always refers to this module's current checkout, including
when directory overrides are used.

Once **both** fresh production architectures exist:

```sh
npm run build
```

First CI assembly requires both real runtime artifacts in their cache directories.
On a fresh checkout containing trusted checked-in `dist/native/`, no download or
compiler is needed to rebuild: `npm run build` first runs
`node native/assemble.mjs --prepare`. This verifies a complete existing cache or,
only when cache resources are missing, validates the installed distribution and
copies its complete artifact sets into the cache before tsdown cleans dist.
An existing corrupt/stale cache fails closed rather than silently replacing it.
Missing/stale installed resources cannot bootstrap a build; obtain newly proven
CI artifacts. No placeholder prebuild or stale digest is accepted.
The explicitly mutating `preparePrebuilds({prebuildsDirectory, installedDirectory})`
export implements this preparation step, with the same directory defaults.
Importing it does not run it.

After preparation the build bundles TypeScript, assembles and re-verifies
`dist/native/win32-{x64,arm64}/{owned-job.node,provenance.json,imports.txt,dependents.txt,compile.txt}`,
writes `dist/native/resources.json` with source fingerprint and binary hashes,
then writes the extension bundle manifest. Missing, stale or mismatched native
assets fail the build. Standalone `node native/assemble.mjs` assembles from the
verified cache; importing that module has no assembly side effect.

## Native proof gate

Cross-compilation is not execution proof. Run **each** artifact on its matching
native Windows hardware/VM with matching Node architecture; x64 emulation on ARM64
does not count as the x64 native gate. Test both Node 22.18.0 and a newer supported
Node against the same artifact to exercise the stable ABI.

The verified addon queries `IsWow64Process2(GetCurrentProcess())` before any
ownership tests. Its native machine must match `process.arch` (x64 `0x8664`,
ARM64 `0xaa64`), and its process machine must be `IMAGE_FILE_MACHINE_UNKNOWN`
(`0`), which means non-emulated in this API. An unknown **native** machine,
emulated process, or failed query rejects the gate. This test-only API requires
Windows 10 / Windows Server 2016 version 1709 or later.
`os.machine()` is diagnostic-only: native ARM64 Node 22.18.0 was observed
reporting `unknown` while Node 24 reported `arm64` on the same ARM64 host.
No environment handoff or libuv machine-name exception authorizes execution.

```powershell
$env:OWNERSHIP_EXPECT_ARCH = "x64" # "arm64" on the native ARM64 runner
$env:OWNERSHIP_BASH_EXE = "<resolved Git-for-Windows bash.exe>"
npm run native:harness:test
npm run native:runtime:test
npm test
```

The suite refuses non-Windows or wrong-machine execution, verifies the raw binary
hash/source provenance before loading, and records Node/Bash architecture.
`OWNERSHIP_HARNESS_ARCHITECTURE` reports only Node architecture/version,
`os.machine()`, and the two Windows API machine codes before asserting the gate.
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

The production native suite additionally exercises actual pipe credits, bounded
input, native status 259, startup errors, missing Bash, unconsumed-output drain
failure, blocked-input cancellation, idempotent disposal and Node Worker
shutdown with real descendants. Full Vitest runner tests cover both capture
APIs, JSON/EOF, backpressure, saturated streams, UTF-8 splits, concurrent runs,
the original timeout/readiness/late-marker gates and exact-owned-PID census
disappearance. Tests do not replace the runner with a platform mock.
Each native runtime terminal receipt carries bounded owned-only lifecycle
snapshots from before output draining and after I/O cleanup: root PID, confirmed
job emptiness, child-end closure, and each channel's thread phase, parent-end
state, queued request, completion flag and last Win32 code. Runtime tests print
these as `OWNERSHIP_RUNTIME_LIFECYCLE`; no process listing or command/environment
capture is involved. The idle-stdin and blocked-writer stop regressions retain
their five-second completion deadline.

Cross-platform build-spec/adapter tests do **not** prove Win32 behavior:

```sh
npm run native:harness:check
```

The original ownership primitive passed all 14 native gates on x64/ARM64 with
Node 22.18.0 and 24.21 at head `3eaebc537c92f34706b0e48dc1f49d980402f8be`
(run `38585029318`). That proof does **not** validate the shared-source extraction
or production transport. Rebuild both kinds and architectures and rerun all
four native lanes before accepting the runtime integration. If creation,
transport, nested-job policy, cold readiness or host shutdown fails, report
that friction instead of adding an ancestry fallback, initialization exemption,
or weaker timing assertion.
