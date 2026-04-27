import React, { useRef, useEffect, useState, useCallback } from "react";
import { TagLatest } from "../../hooks/useDashboard";

interface SensorListProps {
  items: TagLatest[];
}

const CATEGORY_ORDER = ["Extruder", "Laminator", "Winder", "Production", "Unwinder", "Safety"];

const CATEGORY_MAP: Record<string, string> = {
  EXTRUDER_RPM: "Extruder", EXTRUDER_AMP: "Extruder", EXTRUDER_SPEED_PCT: "Extruder",
  EXTRUDER_SPEED_VOL: "Extruder", EXTRUDER_ON_OFF: "Extruder", EXTRUDER_FAULT: "Extruder",
  LAMINATOR_MPM: "Laminator", LAMINATOR_AMP: "Laminator", LAMINATOR_SPEED_PCT: "Laminator",
  LAMINATOR_SPEED_VOL: "Laminator", LAMINATOR_ON_OFF: "Laminator", LAMINATOR_FAULT: "Laminator",
  WINDER_AMP: "Winder", WINDER_TENSION_PCT: "Winder", WINDER_TENSION_VOL: "Winder",
  WINDER_ON_OFF: "Winder", WINDER_FAULT: "Winder",
  MASTER_SPEED_PCT: "Production", RUNNING_METER: "Production", TOTAL_METER: "Production",
  GSM_ENTRY: "Production", GRAM_ENTRY: "Production", SPLICE_ON_OFF: "Production", SPLICE_SPEED: "Production",
  UW_SET_TENSION: "Unwinder", UW_PV_TENSION: "Unwinder",
  EMG_STOP: "Safety", ALARM_IND: "Safety",
};

const FRIENDLY: Record<string, string> = {
  EXTRUDER_RPM: "Ext RPM", EXTRUDER_AMP: "Ext Current", EXTRUDER_SPEED_PCT: "Ext Speed",
  EXTRUDER_SPEED_VOL: "Ext Voltage", EXTRUDER_ON_OFF: "Ext Running", EXTRUDER_FAULT: "Ext Fault",
  LAMINATOR_MPM: "Line Speed", LAMINATOR_AMP: "Lam Current", LAMINATOR_SPEED_PCT: "Lam Speed",
  LAMINATOR_SPEED_VOL: "Lam Voltage", LAMINATOR_ON_OFF: "Lam Running", LAMINATOR_FAULT: "Lam Fault",
  WINDER_AMP: "Win Current", WINDER_TENSION_PCT: "Win Tension", WINDER_TENSION_VOL: "Win Voltage",
  WINDER_ON_OFF: "Win Running", WINDER_FAULT: "Win Fault",
  MASTER_SPEED_PCT: "Master Spd", RUNNING_METER: "Running m", TOTAL_METER: "Total m",
  GSM_ENTRY: "GSM", GRAM_ENTRY: "Gram", SPLICE_ON_OFF: "Splice", SPLICE_SPEED: "Splice Spd",
  UW_SET_TENSION: "Set Tension", UW_PV_TENSION: "PV Tension",
  EMG_STOP: "EMG Stop", ALARM_IND: "Alarm",
};

const UNITS: Record<string, string> = {
  EXTRUDER_RPM: "RPM", EXTRUDER_AMP: "A", EXTRUDER_SPEED_PCT: "%", EXTRUDER_SPEED_VOL: "V",
  LAMINATOR_MPM: "m/min", LAMINATOR_AMP: "A", LAMINATOR_SPEED_PCT: "%", LAMINATOR_SPEED_VOL: "V",
  WINDER_AMP: "A", WINDER_TENSION_PCT: "%", WINDER_TENSION_VOL: "V",
  MASTER_SPEED_PCT: "%", RUNNING_METER: "m", TOTAL_METER: "m",
  GSM_ENTRY: "g/m²", GRAM_ENTRY: "g", SPLICE_SPEED: "m/min",
  UW_SET_TENSION: "N", UW_PV_TENSION: "N",
};

function getDisplayValue(item: TagLatest): string {
  const slug = item.slug || item.tagId;
  if (item.valueNumber != null) {
    const v = item.valueNumber;
    if (slug.endsWith("_PCT") || slug === "SPLICE_SPEED") return String(Math.round(v));
    if (v >= 1000) return v.toFixed(0);
    if (v >= 100)  return v.toFixed(1);
    return v.toFixed(2);
  }
  if (item.valueBool != null) return item.valueBool ? "ON" : "OFF";
  if (item.valueString != null) return item.valueString;
  return "—";
}

function isFaultTag(slug: string) {
  return slug.includes("FAULT") || slug === "EMG_STOP" || slug === "ALARM_IND";
}

function SensorRow({ item }: { item: TagLatest }) {
  const slug = item.slug || item.tagId;
  const val  = getDisplayValue(item);
  const [flash, setFlash] = useState(false);
  const prevRef = useRef<string | null>(null);

  useEffect(() => {
    if (prevRef.current === null) { prevRef.current = val; return; }
    if (prevRef.current !== val) {
      prevRef.current = val;
      setFlash(true);
      const t = setTimeout(() => setFlash(false), 700);
      return () => clearTimeout(t);
    }
  }, [val]);

  const isBool   = item.valueBool != null;
  const isFault  = isFaultTag(slug);
  const isActive = item.valueBool === true;

  let valueColor = flash ? "var(--accent)" : "var(--text)";
  if (isBool) valueColor = isFault ? (isActive ? "#ef4444" : "#22c55e") : (isActive ? "#22c55e" : "var(--text-faint)");

  const unit = UNITS[slug];
  const name = FRIENDLY[slug] ?? slug;

  return (
    /* CSS class handles desktop (flex row) vs mobile (card column) */
    <div className="rvl-sensor-card">
      {/* Label */}
      <span style={{
        fontSize: 10.5, color: "var(--text-faint)", fontWeight: 500,
        overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
        maxWidth: "100%"
      }}>
        {name}
      </span>
      {/* Value + unit */}
      <div style={{ display: "flex", alignItems: "baseline", gap: 3, flexShrink: 0 }}>
        <span style={{
          fontSize: 13, fontFamily: "monospace", fontWeight: 700,
          color: valueColor,
          transition: flash ? "none" : "color .4s",
          fontVariantNumeric: "tabular-nums",
        }}>
          {val}
        </span>
        {!isBool && unit && (
          <span style={{ fontSize: 9.5, color: "var(--text-faint)", fontWeight: 400 }}>{unit}</span>
        )}
      </div>
    </div>
  );
}

export default function SensorList({ items }: SensorListProps) {
  // Deduplicate — prefer entry with actual numeric value
  const dedupMap = new Map<string, TagLatest>();
  for (const item of items) {
    const key = item.slug || item.tagId;
    const ex  = dedupMap.get(key);
    if (!ex || item.valueNumber != null) dedupMap.set(key, item);
  }
  const unique = Array.from(dedupMap.values());

  // Group by category
  const grouped: Record<string, TagLatest[]> = {};
  for (const item of unique) {
    const slug = item.slug || item.tagId;
    const cat  = CATEGORY_MAP[slug] ?? "Other";
    if (!grouped[cat]) grouped[cat] = [];
    grouped[cat].push(item);
  }

  const [expanded, setExpanded] = useState<Record<string, boolean>>(
    Object.fromEntries(CATEGORY_ORDER.map(c => [c, true]))
  );
  const toggle = useCallback((cat: string) => setExpanded(p => ({ ...p, [cat]: !p[cat] })), []);

  const activeCats = [...CATEGORY_ORDER, ...Object.keys(grouped).filter(c => !CATEGORY_ORDER.includes(c))]
    .filter(c => grouped[c]?.length > 0);

  return (
    <section>
      {/* Header */}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 10, paddingBottom: 10, borderBottom: "1px solid var(--border)" }}>
        <span style={{ fontSize: 10.5, fontWeight: 600, color: "var(--text-muted)", textTransform: "uppercase", letterSpacing: "0.07em" }}>
          Live Sensors
        </span>
        <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
          <span style={{ fontSize: 10, color: "var(--text-faint)" }}>{unique.length} tags</span>
          <div className="rvl-live-dot" />
        </div>
      </div>

      {/* Scrollable, hidden scrollbar */}
      <div className="rvl-scroll-hidden" style={{ maxHeight: 520 }}>
        {activeCats.length === 0 && (
          <div style={{ padding: "20px 0", textAlign: "center", color: "var(--text-faint)", fontSize: 12 }}>
            No sensor data yet.<br />Run <code style={{ fontSize: 11 }}>npm run sim</code>
          </div>
        )}

        {activeCats.map(cat => (
          <div key={cat} style={{ marginBottom: 6 }}>
            {/* Category header — hidden on mobile via CSS */}
            <button
              className="rvl-sensor-cat-header"
              onClick={() => toggle(cat)}
              style={{
                display: "flex", alignItems: "center", justifyContent: "space-between",
                width: "100%", padding: "4px 0", background: "none", border: "none",
                cursor: "pointer", fontFamily: "inherit"
              }}
            >
              <span style={{ fontSize: 9.5, fontWeight: 700, color: "var(--text-faint)", textTransform: "uppercase", letterSpacing: "0.1em" }}>
                {cat}
              </span>
              <span style={{ fontSize: 9, color: "var(--text-faint)", display: "inline-block", transform: expanded[cat] ? "rotate(0deg)" : "rotate(-90deg)", transition: "transform .15s" }}>▾</span>
            </button>

            {/* Tag rows — on desktop: stacked; on mobile: 2-col grid */}
            {(expanded[cat] ?? true) && (
              <div className="rvl-sensor-grid">
                {grouped[cat].map(item => (
                  <SensorRow key={item.slug || item.tagId} item={item} />
                ))}
              </div>
            )}
          </div>
        ))}
      </div>
    </section>
  );
}
