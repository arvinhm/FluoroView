/** Step of about `range / count` rounded to 1, 2 or 5 times a power of ten. */
export function niceStep(range: number, count: number): number {
  if (!(range > 0)) return 1;
  const raw = range / count;
  const pow = 10 ** Math.floor(Math.log10(raw));
  const n = raw / pow;
  return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10) * pow;
}

/** Round-numbered tick positions covering [min, max]. */
export function niceTicks(min: number, max: number, count: number): number[] {
  const step = niceStep(max - min, count);
  const out: number[] = [];
  for (let k = Math.ceil(min / step); k * step <= max + step * 1e-9; k++) out.push(+(k * step).toPrecision(12));
  return out;
}
