export interface SparklinePath {
  /** Polyline through every bucket, in a 0..width by 0..height viewBox. */
  line: string;
  /** The same trace closed along the baseline, for a fill. */
  area: string;
  width: number;
  height: number;
  peak: number;
}

/**
 * Projects bucket counts onto a fixed viewBox. A flat series is drawn along the
 * baseline rather than mid-height, so "nothing happened" reads as nothing.
 */
export function sparkline(buckets: number[], width = 120, height = 28): SparklinePath {
  const peak = Math.max(0, ...buckets);
  const inset = 1.5;
  const usable = height - inset * 2;
  const step = buckets.length > 1 ? width / (buckets.length - 1) : 0;

  const points = buckets.map((count, index) => {
    const x = buckets.length > 1 ? index * step : width / 2;
    const y = peak === 0 ? height - inset : height - inset - (count / peak) * usable;
    return `${x.toFixed(2)},${y.toFixed(2)}`;
  });

  const line = points.join(' ');
  const first = buckets.length > 1 ? 0 : width / 2;
  const last = buckets.length > 1 ? width : width / 2;

  return {
    line,
    area: `M ${first},${height} L ${line.replaceAll(' ', ' L ')} L ${last},${height} Z`,
    width,
    height,
    peak,
  };
}
