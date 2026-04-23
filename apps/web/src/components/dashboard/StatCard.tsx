import React from "react";

interface StatCardProps {
  title: string;
  value: string | number;
  unit: string;
  status?: "critical" | "warning" | "good" | "inherit";
}

export default function StatCard({ title, value, unit, status }: StatCardProps) {
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
