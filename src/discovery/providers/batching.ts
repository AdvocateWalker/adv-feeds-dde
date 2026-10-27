export interface RotatingBatch<T> {
  values: T[];
  nextCursor?: string;
}

export function takeRotatingBatch<T>(
  values: T[],
  cursor: string | undefined,
  maximum: number
): RotatingBatch<T> {
  if (values.length === 0) return { values: [] };
  const parsed = Number.parseInt(cursor ?? "0", 10);
  const start = Number.isFinite(parsed) ? Math.max(0, parsed) % values.length : 0;
  const count = Math.min(values.length, Math.max(1, Math.floor(maximum)));
  const batch: T[] = [];
  for (let offset = 0; offset < count; offset += 1) {
    batch.push(values[(start + offset) % values.length]);
  }
  return {
    values: batch,
    nextCursor: String((start + count) % values.length),
  };
}

