import React, { ReactNode } from "react";
import { ExportCurve } from "iconsax-reactjs";

interface ChartCardProps {
  title: string;
  subtitle?: string;
  children: ReactNode;
  height?: number | string;
  onExport?: () => void;
}

export default function ChartCard({ title, subtitle, children, height, onExport }: ChartCardProps) {
  return (
    <div className="rvl-card" style={{ padding: "clamp(16px, 4vw, 24px)" }}>
      <div style={{ marginBottom: 20, display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
        <div>
          <h3 style={{ fontSize: 14, fontWeight: 700, margin: 0 }}>{title}</h3>
          {subtitle && <p style={{ fontSize: 11, color: "var(--text-faint)", margin: "4px 0 0" }}>{subtitle}</p>}
        </div>
        {onExport && (
          <button
            onClick={onExport}
            title="Export chart data (CSV)"
            style={{
              background: "none",
              border: "1px solid var(--border)",
              borderRadius: 6,
              padding: "4px 8px",
              fontSize: 11,
              fontWeight: 500,
              color: "var(--text-muted)",
              cursor: "pointer",
              display: "flex",
              alignItems: "center",
              gap: 6,
              transition: "all .15s ease",
            }}
            onMouseEnter={(e) => {
              (e.currentTarget as HTMLElement).style.background = "var(--surface-2)";
              (e.currentTarget as HTMLElement).style.color = "var(--accent)";
              (e.currentTarget as HTMLElement).style.borderColor = "var(--accent)";
            }}
            onMouseLeave={(e) => {
              (e.currentTarget as HTMLElement).style.background = "none";
              (e.currentTarget as HTMLElement).style.color = "var(--text-muted)";
              (e.currentTarget as HTMLElement).style.borderColor = "var(--border)";
            }}
          >
            <ExportCurve size={13} variant="Bulk" />
            CSV
          </button>
        )}
      </div>
      <div style={{ height }}>{children}</div>
    </div>
  );
}
