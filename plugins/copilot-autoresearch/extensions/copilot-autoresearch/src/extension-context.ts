/**
 * Cwd holder shared by all tools/commands. Updated whenever a hook input
 * arrives carrying a fresh `cwd`. Tools read from this — never `process.cwd()`
 * directly — so that a CLI restart in a different directory or a hot
 * configuration change is reflected immediately.
 */
export interface CwdRef {
  get(): string;
  set(cwd: string): void;
}

export function createCwdRef(initial: string): CwdRef {
  let current = initial;
  return {
    get: () => current,
    set: (cwd: string) => {
      if (typeof cwd === "string" && cwd.length > 0) current = cwd;
    },
  };
}
