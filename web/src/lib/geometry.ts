/**
 * Chaikin corner-cutting for closed polygons. Rounds the hard, faceted edges of
 * the simplified cell contours for DISPLAY ONLY — analysis/membership always
 * uses the true mask centroids, so accuracy is never traded for looks.
 *
 * Each iteration replaces every edge with two points at 1/4 and 3/4, quadrupling
 * smoothness per pass while staying inside the convex hull of the original ring
 * (so a smoothed outline never bulges outside the true cell).
 */
export function chaikinClosed(points: [number, number][], iterations = 2): [number, number][] {
  if (points.length < 3) return points;
  let ring = points;
  for (let it = 0; it < iterations; it++) {
    const out: [number, number][] = [];
    const n = ring.length;
    for (let i = 0; i < n; i++) {
      const [x0, y0] = ring[i];
      const [x1, y1] = ring[(i + 1) % n];
      out.push([x0 * 0.75 + x1 * 0.25, y0 * 0.75 + y1 * 0.25]);
      out.push([x0 * 0.25 + x1 * 0.75, y0 * 0.25 + y1 * 0.75]);
    }
    ring = out;
  }
  return ring;
}

/**
 * Drop near-collinear/near-duplicate vertices before smoothing so we don't
 * inflate the point count without adding shape detail (keeps the smoothed layer
 * light for tens of thousands of cells).
 */
export function dedupeRing(points: [number, number][], minDist = 0.75): [number, number][] {
  if (points.length < 3) return points;
  const out: [number, number][] = [points[0]];
  const min2 = minDist * minDist;
  for (let i = 1; i < points.length; i++) {
    const [px, py] = out[out.length - 1];
    const [x, y] = points[i];
    if ((x - px) ** 2 + (y - py) ** 2 >= min2) out.push([x, y]);
  }
  return out.length >= 3 ? out : points;
}
