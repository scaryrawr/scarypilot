const nativeMachines = new Map([
  ["x64", 0x8664],
  ["arm64", 0xaa64],
]);

export function isNativeWindowsArchitecture(arch, { processMachine, nativeMachine }) {
  const expected = nativeMachines.get(arch);

  // IsWow64Process2 uses UNKNOWN (0) for a non-emulated process, not for its host architecture.
  return expected !== undefined && nativeMachine === expected && processMachine === 0;
}
