import React, { ReactNode } from "react";

interface ChartCardProps {
  title: string;
  subtitle?: string;
  children: ReactNode;
  height?: number | string;
}

export default function ChartCard({ title, subtitle, children, height }: ChartCardProps) {
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
