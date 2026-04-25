import React from "react";
import { TagLatest } from "../../hooks/useDashboard";

interface SensorListProps {
  items: TagLatest[];
}

export default function SensorList({ items }: SensorListProps) {
  return (
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
            <span style={{ fontSize: 12, color: "var(--text-muted)" }}>{item.slug || item.tagId}</span>
            <span style={{ fontSize: 12, fontFamily: "monospace", color: "var(--text)" }}>
              {item.valueNumber?.toFixed(2) ?? String(item.valueBool ?? item.valueString ?? "—")}
            </span>
          </div>
        ))}
      </div>
    </section>
  );
}
