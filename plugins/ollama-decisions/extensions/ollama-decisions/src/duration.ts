export const durationPattern = "^[+-]?(?:0|(?:(?:[0-9]+(?:\\.[0-9]*)?|\\.[0-9]+)(?:ns|us|\\u00b5s|\\u03bcs|ms|s|m|h))+)(?![\\s\\S])";

const durationSyntax = new RegExp(durationPattern);

const units = new Map<string, bigint>([
  ["ns", 1n],
  ["us", 1_000n],
  ["\u00b5s", 1_000n],
  ["\u03bcs", 1_000n],
  ["ms", 1_000_000n],
  ["s", 1_000_000_000n],
  ["m", 60_000_000_000n],
  ["h", 3_600_000_000_000n],
]);

const maxMagnitude = 1n << 63n;

export function isOllamaDuration(value: string): boolean {
  if (!durationSyntax.test(value)) return false;
  let total = 0n;

  for (const part of value.matchAll(/([0-9]*)(?:\.([0-9]*))?(ns|us|\u00b5s|\u03bcs|ms|s|m|h)/g)) {
    const unit = units.get(part[3]);

    if (unit === undefined) return false;
    const integer = BigInt(part[1] || "0");

    if (integer > maxMagnitude / unit) return false;
    let fraction = 0n;
    let scale = 1;

    // Match Go time.ParseDuration's bounded fraction and float64 nanosecond truncation.
    for (const digit of part[2] ?? "") {
      if (fraction > (maxMagnitude - 1n) / 10n) break;
      const next = fraction * 10n + BigInt(digit);

      if (next > maxMagnitude) break;
      fraction = next;
      scale *= 10;
    }

    const component = integer * unit + BigInt(Math.trunc(Number(fraction) * (Number(unit) / scale)));

    if (component > maxMagnitude) return false;
    // Go accumulates uint64 values, accepting two 2^63 components that wrap to zero.
    total = BigInt.asUintN(64, total + component);

    if (total > maxMagnitude) return false;
  }

  return total <= (value.startsWith("-") ? maxMagnitude : maxMagnitude - 1n);
}
