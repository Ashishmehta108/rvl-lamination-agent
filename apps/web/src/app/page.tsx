"use client";

import type { ChangeEvent } from "react";
import { useEffect, useMemo, useState, useRef } from "react";
import { AreaChart, Area, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid } from "recharts";
import { Activity, Flash, MessageText1, Cpu, Warning2, ChartSquare, InfoCircle, Ruler, DocumentText, Danger } from "iconsax-reactjs";
import AppHeader from "../components/AppHeader";

type TagLatest = {
  machineId: string;
  tagId: string;
  ts: string;
  valueNumber?: number | null;
  valueBool?: boolean | null;
  valueString?: string | null;
  quality?: string;
};

type Alert = {
  id: string;
  severity: "critical" | "warning";
  status: string;
  title: string;
  startsAt: string;
};

type ReportRun = {
  id: string;
  status: string;
  createdAt: string;
  metrics?: any;
};

const API = process.env.NEXT_PUBLIC_BACKEND_URL ?? "http://127.0.0.1:7000";
const TOKEN = process.env.NEXT_PUBLIC_API_AUTH_TOKEN ?? "dev-local-token";

export default function HomePage() {
  const [machineId, setMachineId] = useState("machine_1");
  const [items, setItems] = useState<TagLatest[]>([]);
  const [alerts, setAlerts] = useState<Alert[]>([]);
  const [reports, setReports] = useState<ReportRun[]>([]);
  const [history, setHistory] = useState<any[]>([]);
  const [error, setError] = useState(false);
  const [isGeneratingReport, setIsGeneratingReport] = useState(false);
  const historyRef = useRef<any[]>([]);

  const loadData = async () => {
    try {
      const [tagsRes, alertsRes, reportsRes] = await Promise.all([
        fetch(`${API}/tags/latest?machineId=${encodeURIComponent(machineId)}`, { headers: { Authorization: `Bearer ${TOKEN}` } }),
        fetch(`${API}/alerts?machineId=${encodeURIComponent(machineId)}&status=open`, { headers: { Authorization: `Bearer ${TOKEN}` } }),
        fetch(`${API}/reports/runs?machineId=${encodeURIComponent(machineId)}`, { headers: { Authorization: `Bearer ${TOKEN}` } })
      ]);

      const tagsJson = await tagsRes.json();
      const alertsJson = await alertsRes.json();
      const reportsJson = await reportsRes.json();

      const newItems = tagsJson.items ?? [];
      setItems(newItems);
      setAlerts(alertsJson.items ?? []);
      setReports(reportsJson.items ?? []);
      setError(false);

      const point: any = { t: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }) };
      newItems.forEach((item: any) => {
        if (typeof item.valueNumber === 'number') {
          point[item.tagId] = item.valueNumber;
        }
      });

      const newHistory = [...historyRef.current, point].slice(-40);
      historyRef.current = newHistory;
      setHistory(newHistory);
    } catch {
      setError(true);
    }
  };

  useEffect(() => {
    loadData();
    const t = setInterval(loadData, 2000);
    return () => clearInterval(t);
  }, [machineId]);

  const triggerReport = async () => {
    setIsGeneratingReport(true);
    try {
      await fetch(`${API}/reports/trigger`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${TOKEN}` },
        body: JSON.stringify({ machineId })
      });
      setTimeout(loadData, 2000);
    } finally {
      setIsGeneratingReport(false);
    }
  };

  const viewReport = async (runId: string) => {
    try {
      const res = await fetch(`${API}/reports/view/${runId}`, {
        headers: { Authorization: `Bearer ${TOKEN}` }
      });
      if (!res.ok) throw new Error("failed");
      const blob = await res.blob();
      const url = window.URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `report_${runId}.html`;
      document.body.appendChild(a);
      a.click();
      window.URL.revokeObjectURL(url);
    } catch (err) {
      alert("Failed to load report. It may still be generating.");
    }
  };

  const stats = useMemo(() => {

    const temp1 = items.find(i => i.tagId === 'roller_temp_01')?.valueNumber ?? 0;
    const temp2 = items.find(i => i.tagId === 'roller_temp_02')?.valueNumber ?? 0;
    const speed = items.find(i => i.tagId === 'line_speed')?.valueNumber ?? 0;
    const pressure = items.find(i => i.tagId === 'nip_pressure')?.valueNumber ?? 0;
    return { avgTemp: ((temp1 + temp2) / 2).toFixed(1), speed: speed.toFixed(1), pressure: pressure.toFixed(2) };
  }, [items]);

  return (
    <div style={{ minHeight: "100vh", background: "var(--bg)", color: "var(--text)" }}>
      <AppHeader
        title="Industrial Intelligence"
        subtitle="Operational Monitoring & Reporting"
        icon={<Cpu size={14} color="var(--text-muted)" />}
        rightSlot={
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 6, paddingRight: 10, borderRight: "1px solid var(--border)" }}>
              <span style={{ fontSize: 11, color: "var(--text-faint)" }}>Asset</span>
              <input
                className="rvl-input"
                value={machineId}
                onChange={(e: ChangeEvent<HTMLInputElement>) => setMachineId(e.currentTarget.value)}
                style={{ width: 90 }}
              />
            </div>
            <button onClick={triggerReport} disabled={isGeneratingReport} className="rvl-btn-primary" style={{ background: "var(--accent)", color: "#fff", border: "none" }}>
              <DocumentText size={14} />
              {isGeneratingReport ? "Processing..." : "Run Report"}
            </button>
          </div>
        }
      />

      <main style={{ maxWidth: 1200, margin: "0 auto", padding: "32px 20px" }}>
        
        {/* ── Metric Summary ─────────────────────── */}
        <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 20, marginBottom: 32 }}>
          <StatCard title="Thermal Avg" value={stats.avgTemp} unit="°C" />
          <StatCard title="Throughput" value={stats.speed} unit="m/m" />
          <StatCard title="Nip Load" value={stats.pressure} unit="bar" />
          <StatCard title="Alerts Level" value={alerts.length} unit={alerts.some(a => a.severity === 'critical') ? "Critical" : "Nominal"} status={alerts.some(a => a.severity === 'critical') ? 'critical' : alerts.length > 0 ? 'warning' : 'good'} />
        </div>

        <div style={{ display: "grid", gridTemplateColumns: "1fr 340px", gap: 32 }}>
          
          <div style={{ display: "flex", flexDirection: "column", gap: 32 }}>
            <ChartCard title="Thermal Profiles" subtitle="Live Temperature Monitoring">
              <ResponsiveContainer width="100%" height={280}>
                <AreaChart data={history} margin={{ top: 10, right: 0, left: -20, bottom: 0 }}>
                  <CartesianGrid strokeDasharray="4 4" stroke="var(--border)" vertical={false} />
                  <XAxis dataKey="t" hide />
                  <YAxis fontSize={9} stroke="var(--text-faint)" axisLine={false} tickLine={false} />
                  <Tooltip content={<CustomTooltip />} />
                  <Area type="monotone" dataKey="roller_temp_01" stroke="var(--accent)" fill="var(--accent)" fillOpacity={0.03} strokeWidth={1.2} />
                  <Area type="monotone" dataKey="roller_temp_02" stroke="var(--text-muted)" fill="transparent" strokeWidth={1} strokeDasharray="4 2" />
                </AreaChart>
              </ResponsiveContainer>
            </ChartCard>

            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 24 }}>
              <ChartCard title="Pressure Load">
                <ResponsiveContainer width="100%" height={140}>
                  <AreaChart data={history}>
                    <Tooltip content={<CustomTooltip />} />
                    <Area type="step" dataKey="nip_pressure" stroke="var(--text-muted)" fill="var(--surface-2)" strokeWidth={1} />
                  </AreaChart>
                </ResponsiveContainer>
              </ChartCard>
              <ChartCard title="Motion Stream">
                <ResponsiveContainer width="100%" height={140}>
                  <AreaChart data={history}>
                    <Tooltip content={<CustomTooltip />} />
                    <Area type="monotone" dataKey="line_speed" stroke="var(--accent)" fill="var(--accent)" fillOpacity={0.05} strokeWidth={1} />
                  </AreaChart>
                </ResponsiveContainer>
              </ChartCard>
            </div>
            
            {/* Recent Reports Section */}
            <div>
               <h3 style={{ fontSize: 12, fontWeight: 500, color: "var(--text-muted)", marginBottom: 16, display: "flex", alignItems: "center", gap: 8 }}>
                <DocumentText size={14} /> Recent Reports
              </h3>
              <div className="rvl-card" style={{ padding: 0 }}>
                {reports.length === 0 ? (
                  <div style={{ padding: 20, textAlign: "center", color: "var(--text-faint)", fontSize: 12 }}>No reports generated yet. Click "Run Report" to start.</div>
                ) : (
                  reports.map(report => (
                    <div key={report.id} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "12px 20px", borderBottom: "1px solid var(--border-subtle)" }}>
                      <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
                        <div style={{ width: 8, height: 8, borderRadius: "50%", background: report.status === 'succeeded' ? '#10b981' : report.status === 'failed' ? '#ff4d4f' : '#3b82f6' }} />
                        <span style={{ fontSize: 12, fontWeight: 500 }}>{new Date(report.createdAt).toLocaleString()}</span>
                      </div>
                      <div style={{ display: "flex", alignItems: "center", gap: 16 }}>
                        <span style={{ fontSize: 11, color: "var(--text-faint)" }}>{report.metrics?.alerts ?? 0} Alerts</span>
                        <span style={{ fontSize: 11, background: "var(--surface-2)", padding: "2px 8px", borderRadius: 4 }}>{report.status}</span>
                        {report.status === 'succeeded' && (
                          <button onClick={() => viewReport(report.id)} style={{ fontSize: 11, color: "var(--accent)", border: "none", background: "none", cursor: "pointer", fontWeight: 500 }}>
                            View
                          </button>
                        )}
                      </div>
                    </div>
                  ))
                )}
              </div>
            </div>
          </div>

          {/* Sidebar: Alerts & Telemetry */}
          <div style={{ display: "flex", flexDirection: "column", gap: 32 }}>
            
            {/* Alerts Panel */}
            <section>
              <div style={{ padding: "0 4px 12px", borderBottom: "1px solid var(--border)", display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 12 }}>
                <span style={{ fontSize: 11, fontWeight: 500, color: "var(--text-muted)", textTransform: "uppercase", letterSpacing: "0.03em" }}>Active Alerts</span>
                {alerts.length > 0 && <div className="rvl-live-dot" style={{ background: alerts.some(a => a.severity === 'critical') ? '#ff4d4f' : '#f59e0b' }} />}
              </div>
              <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                {alerts.length === 0 ? (
                  <div style={{ padding: "12px 4px", fontSize: 12, color: "var(--text-faint)" }}>System nominal. No active alerts.</div>
                ) : (
                  alerts.slice(0, 5).map(alert => (
                    <div key={alert.id} style={{ 
                      padding: "10px 14px", 
                      borderRadius: 8, 
                      border: "1px solid var(--border)",
                      background: alert.severity === 'critical' ? '#ff4d4f08' : '#f59e0b08',
                      display: "flex",
                      flexDirection: "column",
                      gap: 4
                    }}>
                      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                        <span style={{ fontSize: 11, fontWeight: 600, color: alert.severity === 'critical' ? '#ff4d4f' : '#f59e0b' }}>{alert.severity.toUpperCase()}</span>
                        <span style={{ fontSize: 9, color: "var(--text-faint)" }}>{new Date(alert.startsAt).toLocaleTimeString()}</span>
                      </div>
                      <span style={{ fontSize: 12, color: "var(--text)" }}>{alert.title}</span>
                    </div>
                  ))
                )}
              </div>
            </section>

            {/* Telemetry List */}
            <section>
              <div style={{ padding: "0 4px 12px", borderBottom: "1px solid var(--border)", display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 8 }}>
                <span style={{ fontSize: 11, fontWeight: 500, color: "var(--text-muted)", textTransform: "uppercase", letterSpacing: "0.03em" }}>Sensors</span>
                <div className="rvl-live-dot" />
              </div>
              <div style={{ maxHeight: 300, overflowY: "auto" }}>
                {items.map((item) => (
                  <div key={item.tagId} style={{ 
                    display: "flex", 
                    justifyContent: "space-between", 
                    padding: "8px 4px", 
                    borderBottom: "1px solid var(--border-subtle)"
                  }}>
                    <span style={{ fontSize: 12, color: "var(--text-muted)" }}>{item.tagId}</span>
                    <span style={{ fontSize: 12, fontFamily: "monospace", color: "var(--text)" }}>
                      {item.valueNumber?.toFixed(2) ?? String(item.valueBool ?? item.valueString ?? "—")}
                    </span>
                  </div>
                ))}
              </div>
            </section>
          </div>

        </div>
      </main>
    </div>
  );
}

function StatCard({ title, value, unit, status }: any) {
  const statusColor = status === 'critical' ? '#ff4d4f' : status === 'warning' ? '#f59e0b' : 'inherit';
  return (
    <div className="rvl-card" style={{ padding: "16px 20px" }}>
      <p style={{ fontSize: 10, color: "var(--text-faint)", textTransform: "uppercase", margin: "0 0 6px", letterSpacing: "0.02em", fontWeight: 500 }}>{title}</p>
      <div style={{ display: "flex", alignItems: "baseline", gap: 4 }}>
        <span style={{ fontSize: 20, fontWeight: 500, color: statusColor }}>{value}</span>
        <span style={{ fontSize: 11, color: "var(--text-faint)" }}>{unit}</span>
      </div>
    </div>
  );
}

function ChartCard({ title, subtitle, children, height }: any) {
  return (
    <div className="rvl-card" style={{ padding: "24px" }}>
      <div style={{ marginBottom: 20 }}>
        <h3 style={{ fontSize: 14, fontWeight: 700, margin: 0 }}>{title}</h3>
        {subtitle && <p style={{ fontSize: 11, color: "var(--text-faint)", margin: "4px 0 0" }}>{subtitle}</p>}
      </div>
      <div style={{ height }}>{children}</div>
    </div>
  );
}

function CustomTooltip({ active, payload, label }: any) {
  if (active && payload && payload.length) {
    return (
      <div style={{ background: "var(--surface)", border: "1px solid var(--border)", padding: "10px", borderRadius: 8, boxShadow: "var(--shadow)" }}>
        <p style={{ fontSize: 10, color: "var(--text-faint)", margin: "0 0 8px" }}>{label}</p>
        {payload.map((p: any) => (
          <div key={p.name} style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 4 }}>
            <div style={{ width: 8, height: 8, borderRadius: 2, background: p.color }} />
            <span style={{ fontSize: 11, fontWeight: 600 }}>{p.name}:</span>
            <span style={{ fontSize: 11, fontWeight: 700, color: p.color }}>{p.value.toFixed(2)}</span>
          </div>
        ))}
      </div>
    );
  }
  return null;
}
