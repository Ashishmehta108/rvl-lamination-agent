import React from "react";
import { Alert } from "../../hooks/useDashboard";

interface AlertFeedProps {
  alerts: Alert[];
}

export default function AlertFeed({ alerts }: AlertFeedProps) {
  return (
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
  );
}
