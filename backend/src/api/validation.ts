const BASE58_RE = /^[1-9A-HJ-NP-Za-km-z]+$/;

export function isSolanaAddress(value: unknown): value is string {
  return typeof value === "string" && value.length >= 32 && value.length <= 44 && BASE58_RE.test(value);
}

export function isPositiveNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

export function normalizeLabel(value: unknown) {
  if (typeof value !== "string") return undefined;
  const label = value.trim();
  return label.length > 0 ? label.slice(0, 64) : undefined;
}
