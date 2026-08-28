export function json(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

export function requiredString(value: string, name: string): string {
  const clean = value.trim();
  if (!clean) throw new Error(`${name} is required`);
  return clean;
}
