"use client";

import { useMemo, useState, ChangeEvent, useCallback, type CSSProperties } from "react";
import useSWR from "swr";
import Link from "next/link";
import {
  BarChart,
  Bar,
  Line,
  ComposedChart,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
  CartesianGrid,
  Legend,
} from "recharts";
import { Chart21 } from "iconsax-reactjs";

import AppHeader from "../../components/AppHeader";
import ChartCard from "../../components/dashboard/ChartCard";
import { api } from "../../lib/api";

type Granularity = "daily" | "weekly" | "monthly";

type MetricsResponse = {
  granularity: Granularity;
  from: string;
  to: string;
  buckets: Array<{
    key: string;
    label: string;
    runningMeters: number | null;
    avgExtruderRpm: number | null;
    avgLaminatorMpm: number | null;
    avgGsmEntry: number | null;
    sampleCount: number;
  }>;
};

const C = {
  accent: "#9e5a32",
  blue: "#60a5fa",
  green: "#34d399",
  amber: "#fbbf24",
  border: "var(--border)",
};

function tabStyle(active: boolean): CSSProperties {
  return {
    fontSize: 12,
    fontWeight: active ? 600 : 500,
    padding: "8px 14px",
    borderRadius: 8,
    border: `1px solid ${active ? "var(--border)" : "transparent"}`,
    background: active ? "var(--surface-2)" : "transparent",
    color: active ? "var(--text)" : "var(--text-muted)",
    cursor: "pointer",
    fontFamily: "inherit",
  };
}

function toLocalInputValue(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export default function ProductionPage() {
  const [machineId, setMachineId] = useState("lamination-01");
  const [granularity, setGranularity] = useState<Granularity>("daily");
  const buckets = granularity === "daily" ? "30" : granularity === "weekly" ? "12" : "12";

  const defaultFrom = useMemo(() => {
    const d = new Date(Date.now() - 7 * 86400000);
    return toLocalInputValue(d);
  }, []);
  const defaultTo = useMemo(() => toLocalInputValue(new Date()), []);

  const [rangeFrom, setRangeFrom] = useState(defaultFrom);
  const [rangeTo, setRangeTo] = useState(defaultTo);
  const [appliedRange, setAppliedRange] = useState<{ from: string; to: string } | null>(null);

  const swrKey = useMemo(
    () =>
      appliedRange
        ? ["/metrics/production", machineId, granularity, "range", appliedRange.from, appliedRange.to] as const
        : ([`/metrics/production`, machineId, granularity, buckets] as const),
    [machineId, granularity, buckets, appliedRange]
  );

  const { data, error, isLoading } = useSWR(
    swrKey,
    () =>
      appliedRange
        ? api.get<MetricsResponse>(`/metrics/production`, {
            machineId,
            granularity,
            buckets: "90",
            from: appliedRange.from,
            to: appliedRange.to,
          })
        : api.get<MetricsResponse>(`/metrics/production`, {
            machineId,
            granularity,
            buckets,
          }),
    { revalidateOnFocus: false }
  );

  const applyRange = useCallback(() => {
    const f = new Date(rangeFrom);
    const t = new Date(rangeTo);
    if (Number.isNaN(f.getTime()) || Number.isNaN(t.getTime())) return;
    setAppliedRange({ from: f.toISOString(), to: t.toISOString() });
  }, [rangeFrom, rangeTo]);

  const clearRange = useCallback(() => {
    setAppliedRange(null);
    setRangeFrom(defaultFrom);
    setRangeTo(defaultTo);
  }, [defaultFrom, defaultTo]);

  const exportCsv = useCallback(async () => {
    const fromIso =
      appliedRange?.from ?? (Number.isNaN(new Date(rangeFrom).getTime()) ? new Date(Date.now() - 7 * 86400000).toISOString() : new Date(rangeFrom).toISOString());
    const toIso =
      appliedRange?.to ?? (Number.isNaN(new Date(rangeTo).getTime()) ? new Date().toISOString() : new Date(rangeTo).toISOString());
    try {
      const csv = await api.getText(`/metrics/production/samples`, {
        machineId,
        from: fromIso,
        to: toIso,
      });
      const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `production-${machineId}-${fromIso.slice(0, 10)}_${toIso.slice(0, 10)}.csv`;
      document.body.appendChild(a);
      a.click();
      URL.revokeObjectURL(url);
      a.remove();
    } catch {
      alert("Export failed. Check date range and network.");
    }
  }, [appliedRange, machineId, rangeFrom, rangeTo]);

  const chartData = useMemo(() => {
    if (!data?.buckets?.length) return [];
    return data.buckets.map((b) => ({
      period: b.label,
      meters: b.runningMeters ?? 0,
      rpm: b.avgExtruderRpm ?? null,
      mpm: b.avgLaminatorMpm ?? null,
      gsm: b.avgGsmEntry ?? null,
      samples: b.sampleCount,
    }));
  }, [data]);
  const totalMeters = useMemo(() => chartData.reduce((sum, bucket) => sum + bucket.meters, 0), [chartData]);

  return (
    <div style={{ minHeight: "100vh", background: "var(--bg)", color: "var(--text)" }}>
      <AppHeader
        title="Production analytics"
        subtitle="TagSample rollups (slug via TagDefinition). Simulator: set SIM_INJECT_ALERTS=1 for threshold spikes → dashboard alerts and reports."
        icon={<Chart21 size={14} color="var(--text-muted)" />}
        rightSlot={
          <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
            <span style={{ fontSize: 11, color: "var(--text-faint)" }}>Asset</span>
            <input
              className="rvl-input"
              value={machineId}
              onChange={(e: ChangeEvent<HTMLInputElement>) => setMachineId(e.currentTarget.value)}
              style={{ width: 120 }}
            />
            <Link href="/" className="rvl-btn-primary" style={{ fontSize: 12, textDecoration: "none", padding: "6px 12px" }}>
              Dashboard
            </Link>
          </div>
        }
      />

      <main style={{ maxWidth: 1180, margin: "0 auto", padding: "20px 20px 48px" }}>
        <p style={{ fontSize: 12, color: "var(--text-muted)", marginBottom: 14, lineHeight: 1.5 }}>
          Open <Link href="/">Dashboard</Link> for live alerts and <Link href="/reports">Reports</Link> for HTML runs. CSV export opens in Excel.
        </p>

        <div
          className="rvl-card"
          style={{
            display: "flex",
            flexWrap: "wrap",
            alignItems: "flex-end",
            gap: 12,
            padding: "14px 16px",
            marginBottom: 18,
          }}
        >
          <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
            <label style={{ fontSize: 10, color: "var(--text-faint)", textTransform: "uppercase", letterSpacing: "0.06em" }}>From</label>
            <input className="rvl-input" type="datetime-local" value={rangeFrom} onChange={(e) => setRangeFrom(e.target.value)} style={{ minWidth: 200 }} />
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
            <label style={{ fontSize: 10, color: "var(--text-faint)", textTransform: "uppercase", letterSpacing: "0.06em" }}>To</label>
            <input className="rvl-input" type="datetime-local" value={rangeTo} onChange={(e) => setRangeTo(e.target.value)} style={{ minWidth: 200 }} />
          </div>
          <button type="button" className="rvl-btn-primary" style={{ fontSize: 12 }} onClick={applyRange}>
            Apply range
          </button>
          <button type="button" style={{ fontSize: 12, padding: "6px 12px", borderRadius: 8, border: "1px solid var(--border)", background: "var(--surface-2)", cursor: "pointer" }} onClick={clearRange}>
            Rolling window
          </button>
          <button type="button" style={{ fontSize: 12, padding: "6px 12px", borderRadius: 8, border: "1px solid var(--accent)", color: "var(--accent)", background: "transparent", cursor: "pointer", marginLeft: "auto" }} onClick={exportCsv}>
            Export CSV (Excel)
          </button>
        </div>
        {appliedRange && (
          <p style={{ fontSize: 11, color: "var(--accent)", marginBottom: 12 }}>
            Custom range active (charts respect server caps).
          </p>
        )}

        <div style={{ display: "flex", gap: 8, marginBottom: 20, flexWrap: "wrap" }}>
          {(["daily", "weekly", "monthly"] as const).map((g) => (
            <button key={g} type="button" onClick={() => setGranularity(g)} style={tabStyle(granularity === g)}>
              {g === "daily" ? "Daily" : g === "weekly" ? "Weekly" : "Monthly"}
            </button>
          ))}
        </div>

        {data && (
          <p style={{ fontSize: 12, color: "var(--text-muted)", marginBottom: 16 }}>
            Window: {new Date(data.from).toLocaleString()} — {new Date(data.to).toLocaleString()} · Total produced: {Math.round(totalMeters * 10) / 10} m
          </p>
        )}

        {isLoading && !data && (
          <div className="rvl-card" style={{ padding: 24, textAlign: "center", color: "var(--text-faint)" }}>
            Loading metrics…
          </div>
        )}
        {error && (
          <div className="rvl-card" style={{ padding: 24, color: "#c45" }}>
            Failed to load production metrics.
          </div>
        )}

        {chartData.length > 0 && (
          <div style={{ display: "flex", flexDirection: "column", gap: 18 }}>
            <ChartCard title="Running meters produced" subtitle="Per bucket, reset-aware RUNNING_METER deltas">
              <ResponsiveContainer width="100%" height={260}>
                <BarChart data={chartData} margin={{ top: 8, right: 12, left: 4, bottom: 4 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke={C.border} vertical={false} />
                  <XAxis
                    dataKey="period"
                    tick={{ fontSize: 9, fill: "var(--text-faint)" }}
                    tickLine={false}
                    axisLine={false}
                    interval="preserveStartEnd"
                  />
                  <YAxis tick={{ fontSize: 10, fill: "var(--text-faint)" }} tickLine={false} axisLine={false} width={44} unit=" m" />
                  <Tooltip
                    contentStyle={{ background: "var(--surface)", border: "1px solid var(--border)", fontSize: 11 }}
                    formatter={(v: number) => [`${v} m`, "Produced"]}
                  />
                  <Bar dataKey="meters" name="Meters" fill={C.green} radius={[2, 2, 0, 0]} isAnimationActive={false} />
                </BarChart>
              </ResponsiveContainer>
            </ChartCard>

            <ChartCard title="Process averages" subtitle="Mean sample value per bucket (when samples exist)">
              <ResponsiveContainer width="100%" height={260}>
                <ComposedChart data={chartData} margin={{ top: 8, right: 12, left: 4, bottom: 4 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke={C.border} vertical={false} />
                  <XAxis
                    dataKey="period"
                    tick={{ fontSize: 9, fill: "var(--text-faint)" }}
                    tickLine={false}
                    axisLine={false}
                    interval="preserveStartEnd"
                  />
                  <YAxis yAxisId="left" tick={{ fontSize: 10, fill: "var(--text-faint)" }} tickLine={false} axisLine={false} width={40} />
                  <YAxis
                    yAxisId="right"
                    orientation="right"
                    tick={{ fontSize: 10, fill: "var(--text-faint)" }}
                    tickLine={false}
                    axisLine={false}
                    width={36}
                  />
                  <Tooltip contentStyle={{ background: "var(--surface)", border: "1px solid var(--border)", fontSize: 11 }} />
                  <Legend wrapperStyle={{ fontSize: 10 }} />
                  <Line yAxisId="left" type="monotone" dataKey="rpm" name="Extruder RPM" stroke={C.accent} strokeWidth={1.5} dot={false} isAnimationActive={false} connectNulls />
                  <Line yAxisId="left" type="monotone" dataKey="mpm" name="Line m/min" stroke={C.blue} strokeWidth={1.5} dot={false} isAnimationActive={false} connectNulls />
                  <Line yAxisId="right" type="monotone" dataKey="gsm" name="GSM" stroke={C.amber} strokeWidth={1.5} dot={false} isAnimationActive={false} connectNulls />
                </ComposedChart>
              </ResponsiveContainer>
            </ChartCard>
          </div>
        )}

        {!isLoading && data && chartData.length === 0 && (
          <div className="rvl-card" style={{ padding: 24, color: "var(--text-muted)", fontSize: 13 }}>
            No samples in this range for tracked slugs (RUNNING_METER, EXTRUDER_RPM, LAMINATOR_MPM, GSM_ENTRY) after resolving{" "}
            <code style={{ fontSize: 11 }}>TagDefinition</code>. Run the simulator or ingest; ensure definitions exist for those slugs.
          </div>
        )}
      </main>
    </div>
  );
}
