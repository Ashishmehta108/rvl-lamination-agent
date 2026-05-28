export function summarizeNumbers(values: number[]) {
  if (!values.length) return { min: null, max: null, avg: null, stdDev: null };
  
  let min = values[0]!;
  let max = values[0]!;
  let sum = 0;

  for (const v of values) {
    if (v < min) min = v;
    if (v > max) max = v;
    sum += v;
  }

  const avg = sum / values.length;
  let variance = 0;
  for (const v of values) variance += (v - avg) ** 2;

  return { min, max, avg, stdDev: Math.sqrt(variance / values.length) };
}
