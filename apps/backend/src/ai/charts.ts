import type { AgentToolStep, AgentChart } from "./types.js";

/** Detect whether the user's query implies they want a trend/chart.
 *  Takes toolSteps to verify numeric data was actually returned before
 *  generating a chart — prevents boolean-only charts (EMG_STOP, faults etc.).
 */
export function shouldGenerateChart(userMessage: string, toolSteps: AgentToolStep[]): boolean {
  const m = userMessage.toLowerCase();
  const wantsChart =
    m.includes("trend") ||
    m.includes("history") ||
    m.includes("over time") ||
    m.includes("graph") ||
    m.includes("chart") ||
    m.includes("plot") ||
    m.includes("past") ||
    m.includes("compare");

  if (!wantsChart) return false;

  // Require at least one history or comparison step with real numeric (non-boolean) data
  const chartSteps = toolSteps.filter(
    (s) => (s.tool === "get_tag_history" || s.tool === "get_tag_comparison") && s.status === "success"
  );
  
  const hasNumericData = chartSteps.some((s) => {
    // For comparison, samples are inside each series item
    const seriesArr: any[] = s.tool === "get_tag_comparison" 
      ? (s.result?.series ?? []) 
      : [{ samples: s.result?.samples ?? [] }];

    return seriesArr.some(series => {
      const samples: any[] = series.samples ?? [];
      return (
        samples.length >= 2 &&
        samples.some((d: any) => {
          const v = Number(d.value ?? d.val ?? NaN);
          return !isNaN(v) && v !== 0 && v !== 1;
        })
      );
    });
  });

  return hasNumericData;
}

/** Infer a display unit from a tag slug or name. */
export function inferUnit(tag: string): string {
  const t = tag.toUpperCase();
  // Raw analog voltage — never label as engineering unit
  if (t.includes("_VOL") || t.endsWith("_V")) return "V";
  // Raw loadcell counts — not %
  if (
    t.includes("UW_PV") || t.includes("SUW_PV") ||
    t.includes("UW_SET") || t.includes("SUW_SET")
  ) return "counts";
  if (t.includes("PCT") || t.includes("PERCENT") || t.includes("EFFICIENCY")) return "%";
  if (t.includes("MPM")) return "m/min";
  if (t.includes("RPM")) return "RPM";
  if (t.includes("GSM")) return "g/m²";
  if (t.includes("TEMP") || t.includes("°C")) return "°C";
  if (t.includes("TENSION_PCT") || t.includes("WINDER_TENSION")) return "%";
  if (t.includes("METER") && !t.includes("MPM")) return "m";
  if (t.includes("AMP")) return "A";
  return "";
}

/**
 * Compute actual line speed in m/min from speed % and max speed reference.
 * Use when both MASTER_SPEED_PCT and MACHINE_MAX_LINE_SPEED are available.
 * Example output: "Line speed is 82% = 98.4 m/min (max: 120 m/min, headroom: 21.6 m/min)"
 */
export function computeActualSpeed(
  masterSpeedPct: number,
  machineMaxSpeed: number
): number {
  return Math.round((masterSpeedPct / 100) * machineMaxSpeed * 10) / 10;
}

/**
 * Downsample a series to at most `maxPoints` using LTTB-like bucket averaging.
 * Preserves first and last points for accurate range display.
 */
export function downsampleSeries(
  data: { x: string; y: number }[],
  maxPoints = 500
): { x: string; y: number }[] {
  if (data.length <= maxPoints) return data;
  const bucketSize = Math.ceil(data.length / maxPoints);
  const result: { x: string; y: number }[] = [data[0]!];
  for (let i = 1; i < data.length - 1; i += bucketSize) {
    const bucket = data.slice(i, Math.min(i + bucketSize, data.length - 1));
    const avgY = bucket.reduce((s, p) => s + p.y, 0) / bucket.length;
    // Pick the point closest to bucket midpoint for representative timestamp
    const mid = Math.floor(bucket.length / 2);
    const midPoint = bucket[mid];
    if (midPoint) result.push({ x: midPoint.x, y: Math.round(avgY * 100) / 100 });
  }
  result.push(data[data.length - 1]!);
  return result;
}

export function generateChartsFromHistory(toolSteps: AgentToolStep[]): AgentChart[] {
  console.log(`\x1b[36m[Agent Charts]\x1b[0m Starting chart generation process from operational history...`);
  const charts: AgentChart[] = [];

  const historySteps = toolSteps.filter(
    (s) => s.tool === "get_tag_history" && s.status === "success" && s.result
  );

  if (historySteps.length === 0) {
    console.log(`\x1b[36m[Agent Charts]\x1b[0m No successful tag history steps to chart.`);
    return charts;
  }

  // Group steps by their resolved time window to combine tags into one chart
  const groups: Record<string, AgentToolStep[]> = {};
  for (const step of historySteps) {
    const from = step.result?.from || step.args.from || "default";
    const to = step.result?.to || step.args.to || "default";
    const key = `${from}-${to}`;
    if (!groups[key]) groups[key] = [];
    groups[key].push(step);
  }

  for (const [, steps] of Object.entries(groups)) {
    const seriesList = steps.map(step => {
      const samples: any[] = step.result?.samples || (Array.isArray(step.result) ? step.result : []);
      const slug: string = step.result?.tag?.slug || String(step.args.tag || "");
      const tagName: string = step.result?.tag?.name || slug || "Unknown";

      // Clean data mapping with NaN filtering
      const rawData = samples
        .map((d: any) => ({
          x: (d.ts || d.timestamp || d.t || "") as string,
          y: Number(d.value ?? d.val ?? 0)
        }))
        .filter(p => p.x && !isNaN(p.y));

      return {
        name: slug || tagName,
        displayName: tagName,
        slug,
        unit: inferUnit(slug || tagName),
        data: downsampleSeries(rawData)
      };
    }).filter(s => s.data.length >= 2);

    if (seriesList.length === 0) continue;

    // Build title
    const title = seriesList.length === 1
      ? `Trend: ${seriesList[0]!.displayName}`
      : `Comparative Trend: ${seriesList.map(s => s.displayName).join(" vs ")}`;

    // Determine chart-level unit (use first series, or blank if mixed)
    const units = [...new Set(seriesList.map(s => s.unit).filter(Boolean))];
    const chartUnit = units.length === 1 ? units[0] : units.length > 1 ? "mixed" : undefined;

    charts.push({
      type: "line",
      title,
      unit: chartUnit,
      series: seriesList.map(s => ({ name: s.name, data: s.data }))
    });
  }

  console.log(`\x1b[36m[Agent Charts]\x1b[0m Generated ${charts.length} trend chart(s):`, charts.map(c => c.title));
  return charts;
}
