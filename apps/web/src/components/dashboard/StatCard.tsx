import React, { useRef, useEffect, useState } from "react";

interface StatCardProps {
  title: string;
  value: string | number;
  unit: string;
  status?: "critical" | "warning" | "good" | "inherit";
}

const STATUS_COLOR: Record<string, string> = {
  critical: "#ef4444",
  warning:  "#f59e0b",
  good:     "#22c55e",
  inherit:  "var(--text)",
};

export default function StatCard({ title, value, unit, status }: StatCardProps) {
  const prevRef  = useRef<string | number | null>(null);
  const [flash, setFlash] = useState(false);

  useEffect(() => {
    if (prevRef.current === null) { prevRef.current = value; return; }
    if (prevRef.current !== value) {
      prevRef.current = value;
      setFlash(true);
      const t = setTimeout(() => setFlash(false), 700);
      return () => clearTimeout(t);
    }
  }, [value]);

  const valueColor = status ? STATUS_COLOR[status] ?? "var(--text)" : flash ? "var(--accent)" : "var(--text)";

  return (
    <div className="rvl-card" style={{ padding: "clamp(10px, 3.5vw, 16px) clamp(12px, 4vw, 18px)", position: "relative", overflow: "hidden" }}>
      {/* Subtle left accent bar */}
      {status && status !== "inherit" && (
        <div style={{
          position: "absolute", left: 0, top: 0, bottom: 0, width: 3,
          background: STATUS_COLOR[status],
          borderRadius: "8px 0 0 8px"
        }} />
      )}
      <p style={{
        fontSize: 10, color: "var(--text-faint)", textTransform: "uppercase",
        margin: "0 0 6px", letterSpacing: "0.06em", fontWeight: 600
      }}>
        {title}
      </p>
      <div style={{ display: "flex", alignItems: "baseline", gap: 5 }}>
        <span style={{
          fontSize: 22, fontWeight: 600, lineHeight: 1,
          color: valueColor,
          transition: flash ? "none" : "color .4s",
          fontVariantNumeric: "tabular-nums",
          letterSpacing: "-0.02em"
        }}>
          {value}
        </span>
        <span style={{ fontSize: 11, color: "var(--text-faint)", fontWeight: 500 }}>{unit}</span>
      </div>
    </div>
  );
}
