"use client";

import { useState, useMemo, ChangeEvent } from "react";
import {
  LineChart, Line, AreaChart, Area,
  XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid,
  ReferenceLine, Legend,
} from "recharts";
import { Cpu, DocumentText } from "iconsax-reactjs";

import AppHeader    from "../components/AppHeader";
import StatCard     from "../components/dashboard/StatCard";
import ChartCard    from "../components/dashboard/ChartCard";
import AlertFeed    from "../components/dashboard/AlertFeed";
import SensorList   from "../components/dashboard/SensorList";

import { useDashboard } from "../hooks/useDashboard";
import { api } from "../lib/api";

/* ── color palette ── */
const C = {
  accent:  "#9e5a32",
  blue:    "#60a5fa",
  purple:  "#a78bfa",
  green:   "#34d399",
  amber:   "#fbbf24",
  red:     "#f87171",
  border:  "var(--border)",
  surface: "var(--surface)",
};

export default function HomePage() {
  const [machineId, setMachineId] = useState("lamination-01");
  const [isGeneratingReport, setIsGeneratingReport] = useState(false);

  const { items, alerts, reports, history, mutateReports } = useDashboard(machineId);

  const stats = useMemo(() => {
    const get = (slug: string) =>
      items.find(i => (i.slug || i.tagId) === slug);
    return {
      rpm:  (get("EXTRUDER_RPM")?.valueNumber  ?? 0).toFixed(1),
      mpm:  (get("LAMINATOR_MPM")?.valueNumber ?? 0).toFixed(1),
      gsm:  (get("GSM_ENTRY")?.valueNumber     ?? 0).toFixed(1),
      runM: (get("RUNNING_METER")?.valueNumber ?? 0).toFixed(0),
    };
  }, [items]);

  const triggerReport = async () => {
    setIsGeneratingReport(true);
    try { await api.post("/reports/trigger", { machineId }); setTimeout(mutateReports, 2000); }
    finally { setIsGeneratingReport(false); }
  };

  const viewReport = async (runId: string) => {
    try {
      const blob = await api.getBlob(`/reports/view/${runId}`);
      const url  = window.URL.createObjectURL(blob);
      const a    = document.createElement("a");
      a.href = url; a.download = `report_${runId}.html`;
      document.body.appendChild(a); a.click();
      window.URL.revokeObjectURL(url);
    } catch { alert("Failed to load report."); }
  };

  return (
    <div style={{ minHeight: "100vh", background: "var(--bg)", color: "var(--text)" }}>
      <AppHeader
        title="Industrial Intelligence"
        subtitle="Operational Monitoring & Reporting"
        icon={<Cpu size={14} color="var(--text-muted)" />}
        rightSlot={
          <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
            <div className="rvl-header-asset" style={{ display: "flex", alignItems: "center", gap: 6 }}>
              <span style={{ fontSize: 11, color: "var(--text-faint)", whiteSpace: "nowrap" }}>Asset</span>
              <input className="rvl-input" value={machineId}
                onChange={(e: ChangeEvent<HTMLInputElement>) => setMachineId(e.currentTarget.value)}
                style={{ width: 110, minWidth: 80 }} />
            </div>
            <button onClick={triggerReport} disabled={isGeneratingReport}
              className="rvl-btn-primary" style={{ background: "var(--accent)", color: "#fff", border: "none", whiteSpace: "nowrap" }}>
              <DocumentText size={14} />
              {isGeneratingReport ? "Processing…" : "Run Report"}
            </button>
          </div>
        }
      />

      <main style={{ maxWidth: 1320, margin: "0 auto", padding: "24px 20px 48px" }}>

        {/* ── KPI strip ── */}
        <div className="rvl-grid-kpi">
          <StatCard title="Extruder RPM"  value={stats.rpm}  unit="RPM" />
          <StatCard title="Line Speed"    value={stats.mpm}  unit="m/min" />
          <StatCard title="GSM"           value={stats.gsm}  unit="g/m²" />
          <StatCard
            title="Open Alerts"
            value={alerts.length}
            unit={alerts.some(a => a.severity === "critical") ? "Critical" : "Normal"}
            status={alerts.some(a => a.severity === "critical") ? "critical" : alerts.length > 0 ? "warning" : "good"}
          />
        </div>

        {/* ── Main grid: left charts | right sidebar ── */}
        <div className="rvl-grid-main">

          {/* ── LEFT: charts ── */}
          <div style={{ display: "flex", flexDirection: "column", gap: 18 }}>

            {/* Row 1: Speed trend (full width) */}
            <ChartCard
              title="Extruder RPM & Line Speed"
              subtitle="Dual-axis · last 40 samples · refreshes every 5 s"
            >
              <ResponsiveContainer width="100%" height={200}>
                <LineChart data={history} margin={{ top: 4, right: 16, left: -10, bottom: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke={C.border} vertical={false} />
                  <XAxis dataKey="t" tick={{ fontSize: 9, fill: "var(--text-faint)" }} tickLine={false} axisLine={false} interval="preserveStartEnd" />
                  <YAxis yAxisId="rpm" orientation="left"  tick={{ fontSize: 9, fill: "var(--text-faint)" }} tickLine={false} axisLine={false} width={32} unit=" RPM" />
                  <YAxis yAxisId="mpm" orientation="right" tick={{ fontSize: 9, fill: "var(--text-faint)" }} tickLine={false} axisLine={false} width={42} unit=" m/m" />
                  <Tooltip content={<ChartTip units={{ EXTRUDER_RPM: "RPM", LAMINATOR_MPM: "m/min" }} />} />
                  <Legend iconType="circle" iconSize={6} wrapperStyle={{ fontSize: 10, paddingTop: 6 }} />
                  <Line yAxisId="rpm" type="monotone" dataKey="EXTRUDER_RPM"  name="Extruder RPM"  stroke={C.accent} strokeWidth={1.5} dot={false} isAnimationActive={false} />
                  <Line yAxisId="mpm" type="monotone" dataKey="LAMINATOR_MPM" name="Line Speed"    stroke={C.blue}   strokeWidth={1.5} dot={false} isAnimationActive={false} />
                </LineChart>
              </ResponsiveContainer>
            </ChartCard>

            {/* Row 2: three small charts */}
            <div className="rvl-grid-3col">

              <ChartCard title="Extruder Current" subtitle="A">
                <ResponsiveContainer width="100%" height={130}>
                  <AreaChart data={history} margin={{ top: 4, right: 4, left: -22, bottom: 0 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke={C.border} vertical={false} />
                    <XAxis dataKey="t" hide />
                    <YAxis tick={{ fontSize: 9, fill: "var(--text-faint)" }} tickLine={false} axisLine={false} />
                    <Tooltip content={<ChartTip units={{ EXTRUDER_AMP: "A" }} />} />
                    <Area type="monotone" dataKey="EXTRUDER_AMP" name="Ext A" stroke={C.accent} fill={C.accent} fillOpacity={0.1} strokeWidth={1.5} dot={false} isAnimationActive={false} />
                  </AreaChart>
                </ResponsiveContainer>
              </ChartCard>

              <ChartCard title="Laminator Current" subtitle="A">
                <ResponsiveContainer width="100%" height={130}>
                  <AreaChart data={history} margin={{ top: 4, right: 4, left: -22, bottom: 0 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke={C.border} vertical={false} />
                    <XAxis dataKey="t" hide />
                    <YAxis tick={{ fontSize: 9, fill: "var(--text-faint)" }} tickLine={false} axisLine={false} />
                    <Tooltip content={<ChartTip units={{ LAMINATOR_AMP: "A" }} />} />
                    <Area type="monotone" dataKey="LAMINATOR_AMP" name="Lam A" stroke={C.blue} fill={C.blue} fillOpacity={0.1} strokeWidth={1.5} dot={false} isAnimationActive={false} />
                  </AreaChart>
                </ResponsiveContainer>
              </ChartCard>

              <ChartCard title="Winder Current" subtitle="A">
                <ResponsiveContainer width="100%" height={130}>
                  <AreaChart data={history} margin={{ top: 4, right: 4, left: -22, bottom: 0 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke={C.border} vertical={false} />
                    <XAxis dataKey="t" hide />
                    <YAxis tick={{ fontSize: 9, fill: "var(--text-faint)" }} tickLine={false} axisLine={false} />
                    <Tooltip content={<ChartTip units={{ WINDER_AMP: "A" }} />} />
                    <Area type="monotone" dataKey="WINDER_AMP" name="Win A" stroke={C.purple} fill={C.purple} fillOpacity={0.1} strokeWidth={1.5} dot={false} isAnimationActive={false} />
                  </AreaChart>
                </ResponsiveContainer>
              </ChartCard>
            </div>

            {/* Row 3: two medium charts */}
            <div className="rvl-grid-2col">

              <ChartCard title="Winder Tension" subtitle="% — amber line = 80% warn">
                <ResponsiveContainer width="100%" height={160}>
                  <AreaChart data={history} margin={{ top: 4, right: 8, left: -22, bottom: 0 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke={C.border} vertical={false} />
                    <XAxis dataKey="t" hide />
                    <YAxis domain={[0, 100]} tick={{ fontSize: 9, fill: "var(--text-faint)" }} tickLine={false} axisLine={false} />
                    <Tooltip content={<ChartTip units={{ WINDER_TENSION_PCT: "%" }} />} />
                    <ReferenceLine y={80} stroke={C.amber} strokeDasharray="4 2" strokeWidth={1} label={{ value: "warn", position: "right", fontSize: 8, fill: C.amber }} />
                    <Area type="monotone" dataKey="WINDER_TENSION_PCT" name="Tension %" stroke={C.purple} fill={C.purple} fillOpacity={0.1} strokeWidth={1.5} dot={false} isAnimationActive={false} />
                  </AreaChart>
                </ResponsiveContainer>
              </ChartCard>

              <ChartCard title="Unwinder Tension" subtitle="Set vs. PV · Newtons">
                <ResponsiveContainer width="100%" height={160}>
                  <LineChart data={history} margin={{ top: 4, right: 8, left: -22, bottom: 0 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke={C.border} vertical={false} />
                    <XAxis dataKey="t" hide />
                    <YAxis tick={{ fontSize: 9, fill: "var(--text-faint)" }} tickLine={false} axisLine={false} />
                    <Tooltip content={<ChartTip units={{ UW_SET_TENSION: "N", UW_PV_TENSION: "N" }} />} />
                    <Legend iconType="circle" iconSize={6} wrapperStyle={{ fontSize: 9, paddingTop: 4 }} />
                    <Line type="monotone" dataKey="UW_SET_TENSION" name="Set"  stroke={C.green}  strokeWidth={1.5} dot={false} isAnimationActive={false} strokeDasharray="5 3" />
                    <Line type="monotone" dataKey="UW_PV_TENSION"  name="PV"   stroke={C.accent} strokeWidth={1.5} dot={false} isAnimationActive={false} />
                  </LineChart>
                </ResponsiveContainer>
              </ChartCard>
            </div>

            {/* Row 4: production metrics */}
            <div className="rvl-grid-2col">

              <ChartCard title="Running Meters" subtitle="m — cumulative production">
                <ResponsiveContainer width="100%" height={140}>
                  <AreaChart data={history} margin={{ top: 4, right: 8, left: -22, bottom: 0 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke={C.border} vertical={false} />
                    <XAxis dataKey="t" hide />
                    <YAxis tick={{ fontSize: 9, fill: "var(--text-faint)" }} tickLine={false} axisLine={false} />
                    <Tooltip content={<ChartTip units={{ RUNNING_METER: "m" }} />} />
                    <Area type="monotone" dataKey="RUNNING_METER" name="Running m" stroke={C.green} fill={C.green} fillOpacity={0.1} strokeWidth={1.5} dot={false} isAnimationActive={false} />
                  </AreaChart>
                </ResponsiveContainer>
              </ChartCard>

              <ChartCard title="GSM Entry" subtitle="g/m² — fabric weight">
                <ResponsiveContainer width="100%" height={140}>
                  <AreaChart data={history} margin={{ top: 4, right: 8, left: -22, bottom: 0 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke={C.border} vertical={false} />
                    <XAxis dataKey="t" hide />
                    <YAxis tick={{ fontSize: 9, fill: "var(--text-faint)" }} tickLine={false} axisLine={false} />
                    <Tooltip content={<ChartTip units={{ GSM_ENTRY: "g/m²" }} />} />
                    <Area type="monotone" dataKey="GSM_ENTRY" name="GSM" stroke={C.amber} fill={C.amber} fillOpacity={0.1} strokeWidth={1.5} dot={false} isAnimationActive={false} />
                  </AreaChart>
                </ResponsiveContainer>
              </ChartCard>
            </div>

            {/* Reports */}
            <div>
              <h3 style={{ fontSize: 10.5, fontWeight: 600, color: "var(--text-muted)", marginBottom: 10, textTransform: "uppercase", letterSpacing: "0.06em", display: "flex", alignItems: "center", gap: 7 }}>
                <DocumentText size={13} /> Recent Reports
              </h3>
              <div className="rvl-card" style={{ padding: 0 }}>
                {reports.length === 0 ? (
                  <div style={{ padding: "18px 16px", textAlign: "center", color: "var(--text-faint)", fontSize: 12 }}>
                    No reports yet. Click "Run Report" to generate one.
                  </div>
                ) : reports.map(r => (
                  <div key={r.id} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "9px 16px", borderBottom: "1px solid var(--border-subtle)" }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                      <div style={{ width: 6, height: 6, borderRadius: "50%", flexShrink: 0, background: r.status === "succeeded" ? C.green : r.status === "failed" ? C.red : C.blue }} />
                      <span style={{ fontSize: 12 }}>{new Date(r.createdAt).toLocaleString()}</span>
                    </div>
                    <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
                      <span style={{ fontSize: 11, color: "var(--text-faint)" }}>{r.metrics?.alerts ?? 0} alerts</span>
                      <span style={{ fontSize: 10, background: "var(--surface-2)", padding: "2px 7px", borderRadius: 4 }}>{r.status}</span>
                      {r.status === "succeeded" && (
                        <button onClick={() => viewReport(r.id)} style={{ fontSize: 11, color: "var(--accent)", border: "none", background: "none", cursor: "pointer", fontWeight: 500 }}>View</button>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </div>

          {/* ── RIGHT: alerts + sensors ── */}
          <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
            <AlertFeed alerts={alerts} />
            <div className="rvl-card" style={{ padding: "14px 16px" }}>
              <SensorList items={items} />
            </div>
          </div>
        </div>
      </main>
    </div>
  );
}

/* ── Shared tooltip ── */
function ChartTip({ active, payload, label, units = {} }: any) {
  if (!active || !payload?.length) return null;
  return (
    <div style={{
      background: "var(--surface)", border: "1px solid var(--border)",
      padding: "8px 12px", borderRadius: 8,
      boxShadow: "0 4px 20px rgba(0,0,0,.12)", minWidth: 110
    }}>
      {label && <p style={{ fontSize: 9.5, color: "var(--text-faint)", margin: "0 0 5px" }}>{label}</p>}
      {payload.map((p: any) => (
        <div key={p.name} style={{ display: "flex", alignItems: "center", gap: 7, marginBottom: 2 }}>
          <div style={{ width: 6, height: 6, borderRadius: 2, background: p.color, flexShrink: 0 }} />
          <span style={{ fontSize: 11, color: "var(--text-muted)", flex: 1 }}>{p.name}</span>
          <span style={{ fontSize: 11, fontWeight: 600, color: p.color }}>
            {typeof p.value === "number" ? p.value.toFixed(1) : p.value}
            {units[p.dataKey] ? <span style={{ fontSize: 9, opacity: .7, marginLeft: 2 }}>{units[p.dataKey]}</span> : null}
          </span>
        </div>
      ))}
    </div>
  );
}
