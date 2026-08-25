/**
 * Parse `METRIC name=value` lines emitted by `.auto/measure.sh`.
 *
 * Names: word chars, dots, or µ. Values: finite numbers. Duplicates: last wins.
 * Insertion order is preserved per first occurrence.
 * Rejects prototype-pollution keys.
 */
const METRIC_LINE_REGEX = /^METRIC\s+([\w.µ]+)=(\S+)\s*$/gm;
const DENIED_METRIC_NAMES = new Set(["__proto__", "constructor", "prototype"]);

export function parseMetricLines(output: string): Map<string, number> {
  const metrics = new Map<string, number>();
  METRIC_LINE_REGEX.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = METRIC_LINE_REGEX.exec(output)) !== null) {
    const name = match[1];
    if (DENIED_METRIC_NAMES.has(name)) continue;
    const value = Number(match[2]);
    if (Number.isFinite(value)) metrics.set(name, value);
  }
  return metrics;
}

/**
 * Returns true when the command's primary effect is to invoke the current
 * `.auto/measure.sh` or legacy `autoresearch.sh` benchmark.
 *
 * Strips harmless prefixes (env var assignments, env/time/nice/nohup wrappers),
 * then verifies the remaining command starts with the benchmark (optionally
 * via bash/sh/source and an absolute or `./` path) AND that nothing after it
 * chains another command via `;`, `&&`, `||`, `|`, `&`, or backticks/`$(`.
 * Arguments to the benchmark itself are allowed.
 */
export function isAutoresearchShCommand(command: string): boolean {
  let cmd = command.trim();

  // Strip leading env assignments: FOO=bar BAZ="qux" ...
  cmd = cmd.replace(/^(?:\w+=\S*\s+)+/, "");

  // Strip wrappers env/time/nice/nohup with optional flags
  let prev: string;
  do {
    prev = cmd;
    cmd = cmd.replace(/^(?:env|time|nice|nohup)(?:\s+-\S+(?:\s+\d+)?)*\s+/, "");
  } while (cmd !== prev);

  const startsWithScript =
    /^(?:(?:bash|sh|source)\s+(?:-\w+\s+)*)?(?:\/|\.{1,2}\/|[\w.-]+\/)*(?:autoresearch\.sh|\.auto\/measure\.sh)(?:\s|$)/.test(
      cmd,
    );
  if (!startsWithScript) return false;

  // Reject anything after the benchmark path that introduces a second command.
  // Allowed: positional args / flags / quoted strings.
  // Disallowed: ; && || | & ` $( etc.
  return !/[;&|`]|\$\(/.test(cmd);
}
