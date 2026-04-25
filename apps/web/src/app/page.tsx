"use client";

import { useState, useMemo, ChangeEvent } from "react";
import { AreaChart, Area, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid } from "recharts";
import { Cpu, DocumentText } from "iconsax-reactjs";

import AppHeader from "../components/AppHeader";
import StatCard from "../components/dashboard/StatCard";
import ChartCard from "../components/dashboard/ChartCard";
import AlertFeed from "../components/dashboard/AlertFeed";
import SensorList from "../components/dashboard/SensorList";

import { useDashboard } from "../hooks/useDashboard";
import { api } from "../lib/api";

export default function HomePage() {
  const [machineId, setMachineId] = useState("lamination-01");
  const [isGeneratingReport, setIsGeneratingReport] = useState(false);
  
  const { items, alerts, reports, history, mutateReports } = useDashboard(machineId);

  const triggerReport = async () => {
    setIsGeneratingReport(true);
    try {
      await api.post("/reports/trigger", { machineId });
      setTimeout(mutateReports, 2000);
    } finally {
      setIsGeneratingReport(false);
    }
  };

  const viewReport = async (runId: string) => {
    try {
      const blob = await api.getBlob(`/reports/view/${runId}`);
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
    // Try to find by slug first, then fallback to hardcoded defaults
    const temp1 = items.find(i => i.slug === 'EXTRUDER_RPM' || i.tagId === 'roller_temp_01')?.valueNumber ?? 0;
    const temp2 = items.find(i => i.slug === 'LAMINATOR_AMP' || i.tagId === 'roller_temp_02')?.valueNumber ?? 0;
    const speed = items.find(i => i.slug === 'LAMINATOR_MPM' || i.tagId === 'line_speed')?.valueNumber ?? 0;
    const pressure = items.find(i => i.slug === 'WINDER_AMP' || i.tagId === 'nip_pressure')?.valueNumber ?? 0;
    return { 
      avgTemp: ((temp1 + temp2) / 2).toFixed(1), 
      speed: speed.toFixed(1), 
      pressure: pressure.toFixed(2) 
    };
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
        
        <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 20, marginBottom: 32 }}>
          <StatCard title="Thermal Avg" value={stats.avgTemp} unit="°C" />
          <StatCard title="Throughput" value={stats.speed} unit="m/m" />
          <StatCard title="Nip Load" value={stats.pressure} unit="bar" />
          <StatCard 
            title="Alerts Level" 
            value={alerts.length} 
            unit={alerts.some(a => a.severity === 'critical') ? "Critical" : "Nominal"} 
            status={alerts.some(a => a.severity === 'critical') ? 'critical' : alerts.length > 0 ? 'warning' : 'good'} 
          />
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
                  <Area type="monotone" dataKey="EXTRUDER_RPM" stroke="var(--accent)" fill="var(--accent)" fillOpacity={0.03} strokeWidth={1.2} />
                  <Area type="monotone" dataKey="LAMINATOR_AMP" stroke="var(--text-muted)" fill="transparent" strokeWidth={1} strokeDasharray="4 2" />
                </AreaChart>
              </ResponsiveContainer>
            </ChartCard>

            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 24 }}>
              <ChartCard title="Pressure Load">
                <ResponsiveContainer width="100%" height={140}>
                  <AreaChart data={history}>
                    <Tooltip content={<CustomTooltip />} />
                    <Area type="step" dataKey="WINDER_AMP" stroke="var(--text-muted)" fill="var(--surface-2)" strokeWidth={1} />
                  </AreaChart>
                </ResponsiveContainer>
              </ChartCard>
              <ChartCard title="Motion Stream">
                <ResponsiveContainer width="100%" height={140}>
                  <AreaChart data={history}>
                    <Tooltip content={<CustomTooltip />} />
                    <Area type="monotone" dataKey="LAMINATOR_MPM" stroke="var(--accent)" fill="var(--accent)" fillOpacity={0.05} strokeWidth={1} />
                  </AreaChart>
                </ResponsiveContainer>
              </ChartCard>
            </div>
            
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

          <div style={{ display: "flex", flexDirection: "column", gap: 32 }}>
            <AlertFeed alerts={alerts} />
            <SensorList items={items} />
          </div>

        </div>
      </main>
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
