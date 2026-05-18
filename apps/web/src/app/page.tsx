"use client";

import { useState, useMemo, ChangeEvent } from "react";
import {
  LineChart, Line, AreaChart, Area,
  XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid,
  ReferenceLine, Legend,
} from "recharts";
import Link from "next/link";
import { Cpu, DocumentText, Clock } from "iconsax-reactjs";

import AppHeader from "../components/AppHeader";
import StatCard from "../components/dashboard/StatCard";
import ChartCard from "../components/dashboard/ChartCard";
import AlertFeed from "../components/dashboard/AlertFeed";
import SensorList from "../components/dashboard/SensorList";

import { useDashboard } from "../hooks/useDashboard";
import { api } from "../lib/api";
import { useAppContext } from "../context/AppContext";

/* ── color palette ── */
const C = {
  accent: "#9e5a32",
  blue: "#60a5fa",
  purple: "#a78bfa",
  green: "#34d399",
  amber: "#fbbf24",
  red: "#f87171",
  border: "var(--border)",
  surface: "var(--surface)",
};

export default function HomePage() {
  const { machineId, setMachineId, isGeneratingReport, triggerReport } = useAppContext();
  const { items, alerts, reports, history, mutateReports } = useDashboard(machineId);

  const stats = useMemo(() => {
    const get = (slug: string) =>
      items.find(i => (i.slug || i.tagId) === slug);
    const masterPct   = get("MASTER_SPEED_PCT")?.valueNumber ?? 0;
    const maxSpeed    = get("MACHINE_MAX_LINE_SPEED")?.valueNumber ?? 0;
    const actualMpm   = maxSpeed > 0 ? Math.round((masterPct / 100) * maxSpeed * 10) / 10 : null;
    return {
      rpm:       (get("EXTRUDER_RPM")?.valueNumber  ?? 0).toFixed(1),
      mpm:       (get("LAMINATOR_MPM")?.valueNumber ?? 0).toFixed(1),
      gsm:       (get("GSM_ENTRY")?.valueNumber     ?? 0).toFixed(1),
      runM:      (get("RUNNING_METER")?.valueNumber ?? 0).toFixed(0),
      masterPct: masterPct.toFixed(0),
      actualMpm,
      hotplateOn:     get("HOTPLATE_ENABLE")?.valueBool ?? null,
      hotplateClose:  get("HOTPLATE_CLOSE")?.valueBool ?? null,
      sandwichOn:     get("SANDWICH_UW_ENABLE")?.valueBool ?? null,
      gsmMode:        get("GSM_SELECTION")?.valueBool ?? null,
      gramMode:       get("GRAM_LOGIC_SELECTION")?.valueBool ?? null,
      logicEnabled:   get("LOGIC_ENABLE")?.valueBool ?? null,
      airPressureLow: get("AIR_PRESSURE_LOW")?.valueBool ?? null,
    };
  }, [items]);

  const viewReport = async (runId: string) => {
    const tid = toast.loading("Preparing download...");
    try {
      const blob = await api.getBlob(`/reports/view/${runId}`);
      const url = window.URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url; a.download = `report_${runId}.html`;
      document.body.appendChild(a); a.click();
      window.URL.revokeObjectURL(url);
      toast.success("Download started", { id: tid });
    } catch (err: any) {
      toast.error("Failed to load report", { id: tid, description: err.message || "An unexpected error occurred." });
    }
  };

  const triggerCsvExport = (tags: string[]) => {
    const from = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const to = new Date().toISOString();
    const url = `/api/proxy/metrics/production/samples?machineId=${machineId}&from=${from}&to=${to}&tags=${tags.join(",")}`;
    
    const a = document.createElement("a");
    a.href = url;
    a.download = `data-${machineId}-${new Date().getTime()}.csv`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    toast.success(`Exporting ${tags.length} tags (last 24h)`);
  };

  const emailBadge = (m: any) => {
    if (!m || typeof m !== "object") return null;
    if (m.emailSent === true) {
      return <span style={{ fontSize: 9, padding: "1px 6px", borderRadius: 4, background: "color-mix(in srgb, #22c55e 15%, transparent)", color: "#16a34a" }}>Emailed</span>;
    }
    if (m.emailError) {
      return <span title={String(m.emailError)} style={{ fontSize: 9, padding: "1px 6px", borderRadius: 4, background: "color-mix(in srgb, #f87171 15%, transparent)", color: "#b91c1c" }}>Email failed</span>;
    }
    return null;
  };

  return (
    <div style={{ minHeight: "100vh", background: "var(--bg)", color: "var(--text)" }}>
      <AppHeader
        title="Industrial Intelligence"
        subtitle="Operational Monitoring & Reporting"
        icon={<Cpu size={14} color="var(--text-muted)" />}
        rightSlot={
          <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
            <Link href="/history" style={{ fontSize: 12, display: "flex", alignItems: "center", gap: 5, color: "var(--text-muted)", textDecoration: "none", padding: "5px 10px", borderRadius: 6, border: "1px solid var(--border)" }}>
              <Clock size={13} /> History
            </Link>
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

      <main style={{ maxWidth: 1320, margin: "0 auto", padding: "clamp(16px, 4vw, 24px) clamp(12px, 3vw, 20px) 48px" }}>

        {/* ── KPI strip ── */}
        <div className="rvl-grid-kpi">
          <StatCard title="Extruder RPM" value={stats.rpm} unit="RPM" />
          <StatCard title="Line Speed" value={stats.mpm} unit="m/min" />
          <StatCard title="GSM" value={stats.gsm} unit="g/m²" />
          <StatCard
            title="Open Alerts"
            value={alerts.length}
            unit={alerts.some(a => a.severity === "critical") ? "Critical" : "Normal"}
            status={alerts.some(a => a.severity === "critical") ? "critical" : alerts.length > 0 ? "warning" : "good"}
          />
        </div>

        {/* ── Status badges ── */}
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 4 }}>
          {[
            { label: "Logic",       on: stats.logicEnabled,   onText: "Enabled",   offText: "DISABLED", danger: stats.logicEnabled === false },
            { label: "Hotplate",    on: stats.hotplateOn,     onText: "On",        offText: "Off" },
            { label: "Hotplate Pos",on: stats.hotplateClose,  onText: "Closed",    offText: "Open" },
            { label: "Sandwich UW", on: stats.sandwichOn,     onText: "Running",   offText: "Off" },
            { label: "Air Pressure",on: stats.airPressureLow === false, onText: "OK", offText: "LOW ⚠", danger: stats.airPressureLow === true },
            { label: "Mode",        on: null, onText: stats.gsmMode ? "GSM" : stats.gramMode ? "Gram" : "—", offText: "", alwaysShow: true },
          ].map(b => b.on !== null || b.alwaysShow ? (
            <span key={b.label} style={{
              fontSize: 11, padding: "3px 10px", borderRadius: 20,
              background: b.danger ? "color-mix(in srgb,#f87171 15%,transparent)" :
                          b.on ? "color-mix(in srgb,#34d399 12%,transparent)" : "var(--surface-2)",
              color: b.danger ? "#f87171" : b.on ? "#34d399" : "var(--text-muted)",
              border: `1px solid ${b.danger ? "#f87171" : b.on ? "#34d399" : "var(--border)"}`,
              fontWeight: 500,
            }}>
              {b.label}: {b.on === null ? b.onText : b.on ? b.onText : b.offText}
            </span>
          ) : null)}
          {stats.actualMpm !== null && (
            <span style={{ fontSize: 11, padding: "3px 10px", borderRadius: 20, background: "var(--surface-2)", color: "var(--text-muted)", border: "1px solid var(--border)", fontWeight: 500 }}>
              Speed: {stats.masterPct}% = {stats.actualMpm} m/min
            </span>
          )}
        </div>

        {/* ── Main grid: left charts | right sidebar ── */}
        <div className="rvl-grid-main">

          {/* ── LEFT: charts ── */}
          <div style={{ display: "flex", flexDirection: "column", gap: 18 }}>

            {/* Row 1: Speed trend (full width) */}
            <ChartCard
              title="Extruder RPM & Line Speed"
              subtitle="Dual-axis · last 40 samples · refreshes every 5 s"
              onExport={() => triggerCsvExport(["EXTRUDER_RPM", "LAMINATOR_MPM"])}
            >
              <ResponsiveContainer width="100%" height={200}>
                <LineChart data={history} margin={{ top: 4, right: 16, left: -10, bottom: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke={C.border} vertical={false} />
                  <XAxis dataKey="t" tick={{ fontSize: 9, fill: "var(--text-faint)" }} tickLine={false} axisLine={false} interval="preserveStartEnd" />
                  <YAxis yAxisId="rpm" orientation="left" tick={{ fontSize: 9, fill: "var(--text-faint)" }} tickLine={false} axisLine={false} width={32} unit=" RPM" />
                  <YAxis yAxisId="mpm" orientation="right" tick={{ fontSize: 9, fill: "var(--text-faint)" }} tickLine={false} axisLine={false} width={42} unit=" m/m" />
                  <Tooltip content={<ChartTip units={{ EXTRUDER_RPM: "RPM", LAMINATOR_MPM: "m/min" }} />} />
                  <Legend iconType="circle" iconSize={6} wrapperStyle={{ fontSize: 10, paddingTop: 6 }} />
                  <Line yAxisId="rpm" type="monotone" dataKey="EXTRUDER_RPM" name="Extruder RPM" stroke={C.accent} strokeWidth={1.5} dot={false} isAnimationActive={false} />
                  <Line yAxisId="mpm" type="monotone" dataKey="LAMINATOR_MPM" name="Line Speed" stroke={C.blue} strokeWidth={1.5} dot={false} isAnimationActive={false} />
                </LineChart>
              </ResponsiveContainer>
            </ChartCard>

            {/* Row 2: three small charts */}
            <div className="rvl-grid-3col">

              <ChartCard title="Extruder Current" subtitle="A" onExport={() => triggerCsvExport(["EXTRUDER_AMP"])}>
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

              <ChartCard title="Laminator Current" subtitle="A" onExport={() => triggerCsvExport(["LAMINATOR_AMP"])}>
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

              <ChartCard title="Winder Current" subtitle="A" onExport={() => triggerCsvExport(["WINDER_AMP"])}>
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

            {/* Row 3: tension charts */}
            <div className="rvl-grid-2col">

              <ChartCard title="Winder Tension" subtitle="% — amber=80% warn · red=5% low alarm">
                <ResponsiveContainer width="100%" height={160}>
                  <AreaChart data={history} margin={{ top: 4, right: 8, left: -22, bottom: 0 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke={C.border} vertical={false} />
                    <XAxis dataKey="t" hide />
                    <YAxis domain={[0, 100]} tick={{ fontSize: 9, fill: "var(--text-faint)" }} tickLine={false} axisLine={false} />
                    <Tooltip content={<ChartTip units={{ WINDER_TENSION_PCT: "%" }} />} />
                    <ReferenceLine y={80} stroke={C.amber} strokeDasharray="4 2" strokeWidth={1} label={{ value: "warn hi", position: "right", fontSize: 8, fill: C.amber }} />
                    <ReferenceLine y={5}  stroke={C.red}   strokeDasharray="4 2" strokeWidth={1} label={{ value: "alarm lo", position: "right", fontSize: 8, fill: C.red }} />
                    <Area type="monotone" dataKey="WINDER_TENSION_PCT" name="Tension %" stroke={C.purple} fill={C.purple} fillOpacity={0.1} strokeWidth={1.5} dot={false} isAnimationActive={false} />
                  </AreaChart>
                </ResponsiveContainer>
              </ChartCard>

              <ChartCard title="Unwinder Tension" subtitle="Set vs. PV · counts">
                <ResponsiveContainer width="100%" height={160}>
                  <LineChart data={history} margin={{ top: 4, right: 8, left: -22, bottom: 0 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke={C.border} vertical={false} />
                    <XAxis dataKey="t" hide />
                    <YAxis tick={{ fontSize: 9, fill: "var(--text-faint)" }} tickLine={false} axisLine={false} />
                    <Tooltip content={<ChartTip units={{ UW_SET_TENSION: "cts", UW_PV_TENSION: "cts" }} />} />
                    <Legend iconType="circle" iconSize={6} wrapperStyle={{ fontSize: 9, paddingTop: 4 }} />
                    <Line type="monotone" dataKey="UW_SET_TENSION" name="Set" stroke={C.green} strokeWidth={1.5} dot={false} isAnimationActive={false} strokeDasharray="5 3" />
                    <Line type="monotone" dataKey="UW_PV_TENSION" name="PV" stroke={C.accent} strokeWidth={1.5} dot={false} isAnimationActive={false} />
                  </LineChart>
                </ResponsiveContainer>
              </ChartCard>
            </div>

            {/* Row 4: Sandwich UW tension */}
            <div className="rvl-grid-2col">
              <ChartCard title="Sandwich UW Tension" subtitle="Set vs. PV · counts (second film layer)">
                <ResponsiveContainer width="100%" height={150}>
                  <LineChart data={history} margin={{ top: 4, right: 8, left: -22, bottom: 0 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke={C.border} vertical={false} />
                    <XAxis dataKey="t" hide />
                    <YAxis tick={{ fontSize: 9, fill: "var(--text-faint)" }} tickLine={false} axisLine={false} />
                    <Tooltip content={<ChartTip units={{ SUW_SET_TENSION: "cts", SUW_PV_TENSION: "cts" }} />} />
                    <Legend iconType="circle" iconSize={6} wrapperStyle={{ fontSize: 9, paddingTop: 4 }} />
                    <Line type="monotone" dataKey="SUW_SET_TENSION" name="Set" stroke={C.blue}   strokeWidth={1.5} dot={false} isAnimationActive={false} strokeDasharray="5 3" />
                    <Line type="monotone" dataKey="SUW_PV_TENSION"  name="PV"  stroke={C.green}  strokeWidth={1.5} dot={false} isAnimationActive={false} />
                  </LineChart>
                </ResponsiveContainer>
              </ChartCard>

              <ChartCard title="Master Speed" subtitle="% setpoint over time">
                <ResponsiveContainer width="100%" height={150}>
                  <AreaChart data={history} margin={{ top: 4, right: 8, left: -22, bottom: 0 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke={C.border} vertical={false} />
                    <XAxis dataKey="t" hide />
                    <YAxis domain={[0, 100]} tick={{ fontSize: 9, fill: "var(--text-faint)" }} tickLine={false} axisLine={false} />
                    <Tooltip content={<ChartTip units={{ MASTER_SPEED_PCT: "%" }} />} />
                    <ReferenceLine y={95} stroke={C.amber} strokeDasharray="4 2" strokeWidth={1} />
                    <Area type="monotone" dataKey="MASTER_SPEED_PCT" name="Speed %" stroke={C.blue} fill={C.blue} fillOpacity={0.1} strokeWidth={1.5} dot={false} isAnimationActive={false} />
                  </AreaChart>
                </ResponsiveContainer>
              </ChartCard>
            </div>

            {/* Row 4: production metrics */}
            <div className="rvl-grid-2col">

              <ChartCard title="Running Meters" subtitle="m — cumulative production" onExport={() => triggerCsvExport(["RUNNING_METER"])}>
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

              <ChartCard title="GSM Entry" subtitle="g/m² — fabric weight" onExport={() => triggerCsvExport(["GSM_ENTRY"])}>
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
              <h3 style={{ fontSize: 10.5, fontWeight: 600, color: "var(--text-muted)", marginBottom: 10, textTransform: "uppercase", letterSpacing: "0.06em", display: "flex", alignItems: "center", gap: 7, justifyContent: "space-between", flexWrap: "wrap" }}>
                <span style={{ display: "inline-flex", alignItems: "center", gap: 7 }}>
                  <DocumentText size={13} /> Recent Reports
                </span>
                <Link href={`/reports?machineId=${encodeURIComponent(machineId)}`} style={{ fontSize: 11, fontWeight: 500, color: "var(--accent)", textDecoration: "none" }}>
                  View all →
                </Link>
              </h3>
              <div className="rvl-card" style={{ padding: 0 }}>
                {reports.length === 0 ? (
                  <div style={{ padding: "18px 16px", textAlign: "center", color: "var(--text-faint)", fontSize: 12 }}>
                    No reports yet. Click "Run Report" to generate one.
                  </div>
                ) : reports.map(r => (
                  <div key={r.id} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "10px 16px", borderBottom: "1px solid var(--border-subtle)", flexWrap: "wrap", gap: 10 }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 10, minWidth: 0 }}>
                      <div style={{ width: 6, height: 6, borderRadius: "50%", flexShrink: 0, background: r.status === "succeeded" ? C.green : r.status === "failed" ? C.red : C.blue }} />
                      <span style={{ fontSize: 12, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{new Date(r.createdAt).toLocaleString()}</span>
                    </div>
                    <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
                      <span className="rvl-hide-mobile" style={{ fontSize: 11, color: "var(--text-faint)" }}>{r.metrics?.alerts ?? 0} alerts</span>
                      {emailBadge(r.metrics)}
                      <span style={{ fontSize: 10, background: "var(--surface-2)", padding: "2px 7px", borderRadius: 4 }}>{r.status}</span>
                      {r.status === "succeeded" && (
                        <div style={{ display: "flex", gap: 12 }}>
                          <Link href={`/reports/${encodeURIComponent(r.id)}?machineId=${encodeURIComponent(machineId)}`} style={{ fontSize: 11, color: "var(--accent)", fontWeight: 500, textDecoration: "none" }}>
                            Open
                          </Link>
                          <button type="button" onClick={() => viewReport(r.id)} style={{ fontSize: 11, color: "var(--text-muted)", border: "none", background: "none", cursor: "pointer", fontWeight: 500 }}>Download</button>
                        </div>
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
