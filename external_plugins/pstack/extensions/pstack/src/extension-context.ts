export interface CwdRef {
  readonly get: () => string;
  readonly set: (cwd: string) => void;
}

export function createCwdRef(initial: string): CwdRef {
  let cwd = initial;
  return {
    get: () => cwd,
    set: (next) => {
      cwd = next;
    },
  };
}
