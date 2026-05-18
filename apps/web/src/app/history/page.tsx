"use client";

import { useState, useCallback } from "react";
import {
  LineChart, Line, AreaChart, Area,
  XAxis, YAxis, Tooltip, ResponsiveContainer,
  CartesianGrid, ReferenceLine, Legend,
} from "recharts";
import AppHeader from "../../components/AppHeader";
import { Clock } from "iconsax-reactjs";
import { api } from "../../lib/api";

/* ─── colour palette ─── */
const C = {
  accent: "#9e5a32", blue: "#60a5fa", green: "#34d399",
  amber: "#fbbf24", red: "#f87171", purple: "#a78bfa",
};

/* ─── Tags available for historical view grouped by subsystem ─── */
const TAG_GROUPS: { label: string; tags: { slug: string; name: string; unit: string }[] }[] = [
  {
    label: "Line / Master",
    tags: [
      { slug: "MASTER_SPEED_PCT", name: "Master Speed", unit: "%" },
      { slug: "MACHINE_MAX_LINE_SPEED", name: "Max Line Speed", unit: "m/min" },
    ],
  },
  {
    label: "Extruder",
    tags: [
      { slug: "EXTRUDER_RPM", name: "Extruder RPM", unit: "RPM" },
      { slug: "EXTRUDER_AMP", name: "Extruder Amps", unit: "A" },
      { slug: "EXTRUDER_SPEED_PCT", name: "Extruder Speed", unit: "%" },
    ],
  },
  {
    label: "Laminator",
    tags: [
      { slug: "LAMINATOR_MPM", name: "Laminator Speed", unit: "m/min" },
      { slug: "LAMINATOR_AMP", name: "Laminator Amps", unit: "A" },
      { slug: "LAMINATOR_SPEED_PCT", name: "Laminator Speed %", unit: "%" },
    ],
  },
  {
    label: "Winder",
    tags: [
      { slug: "WINDER_TENSION_PCT", name: "Winder Tension", unit: "%" },
      { slug: "WINDER_AMP", name: "Winder Amps", unit: "A" },
    ],
  },
  {
    label: "Unwinder",
    tags: [
      { slug: "UW_SET_TENSION", name: "UW Set Tension", unit: "counts" },
      { slug: "UW_PV_TENSION", name: "UW Actual Tension", unit: "counts" },
      { slug: "SUW_SET_TENSION", name: "Sandwich UW Set", unit: "counts" },
      { slug: "SUW_PV_TENSION", name: "Sandwich UW PV", unit: "counts" },
    ],
  },
  {
    label: "Production",
    tags: [
      { slug: "RUNNING_METER", name: "Running Meters", unit: "m" },
      { slug: "TOTAL_METER", name: "Total Meters", unit: "m" },
      { slug: "GSM_ENTRY", name: "GSM", unit: "g/m²" },
      { slug: "GRAM_ENTRY", name: "Gram Entry", unit: "g" },
    ],
  },
  {
    label: "Hotplate",
    tags: [
      { slug: "HOTPLATE_AUTO_CLOSE_MPM", name: "Hotplate Auto-Close Speed", unit: "m/min" },
    ],
  },
];

const PRESETS = [
  { label: "Last 1 h", from: "1h", to: "" },
  { label: "Last 4 h", from: "4h", to: "" },
  { label: "Last 8 h", from: "8h", to: "" },
  { label: "Last 24 h", from: "24h", to: "" },
  { label: "Last 7 d", from: "7d", to: "" },
];

const COLORS = [C.accent, C.blue, C.green, C.amber, C.purple, C.red];

interface Sample { x: string;[key: string]: any }

export default function HistoryPage() {
  const [machineId] = useState("lamination-01");
  const [selectedTags, setSelectedTags] = useState<string[]>(["EXTRUDER_RPM"]);
  const [preset, setPreset] = useState("1h");
  const [fromCustom, setFromCustom] = useState("");
  const [toCustom, setToCustom] = useState("");
  const [data, setData] = useState<Sample[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [fetchedMeta, setFetchedMeta] = useState<{ unit: string; slug: string }[]>([]);

  const toggleTag = (slug: string) =>
    setSelectedTags(prev =>
      prev.includes(slug) ? prev.filter(t => t !== slug) : [...prev, slug]
    );

  const allTags = TAG_GROUPS.flatMap(g => g.tags);

  const fetchHistory = useCallback(async () => {
    if (!selectedTags.length) return;
    setLoading(true);
    setError("");
    try {
      const from = fromCustom || preset;
      const to = toCustom || undefined;

      const results = await Promise.all(
        selectedTags.map(tag =>
          api.get<any>(`/tags/${encodeURIComponent(tag)}/history`, {
            machineId, from, ...(to ? { to } : {}), limit: "500",
          }).catch(() => null)
        )
      );

      // Merge all series into single time-keyed map
      const map: Record<string, Sample> = {};
      const meta: { unit: string; slug: string }[] = [];

      results.forEach((res, i) => {
        const slug = selectedTags[i]!;
        const tagInfo = allTags.find(t => t.slug === slug);
        meta.push({ slug, unit: tagInfo?.unit ?? "" });
        const samples: any[] = res?.samples ?? [];
        samples.forEach((s: any) => {
          const ts = s.ts || s.timestamp || s.t || "";
          if (!map[ts]) map[ts] = { x: ts };
          map[ts][slug] = typeof s.value === "number" ? s.value : Number(s.value ?? s.val ?? NaN);
        });
      });

      const sorted = Object.values(map).sort(
        (a, b) => new Date(a.x).getTime() - new Date(b.x).getTime()
      );
      setData(sorted);
      setFetchedMeta(meta);
    } catch (e: any) {
      setError(e?.message ?? "Failed to load history");
    } finally {
      setLoading(false);
    }
  }, [selectedTags, preset, fromCustom, toCustom, machineId]);

  const units = [...new Set(fetchedMeta.map(m => m.unit).filter(Boolean))];
  const unitLabel = units.length === 1 ? units[0] : units.length > 1 ? "mixed" : "";

  return (
    <div style={{ minHeight: "100vh", background: "var(--bg)", color: "var(--text)" }}>
      <AppHeader
        title="Historical View"
        subtitle="Tag trend explorer · IST timestamps"
        icon={<Clock size={14} color="var(--text-muted)" />}
      />

      <main style={{ maxWidth: 1320, margin: "0 auto", padding: "24px 20px 60px" }}>
        <div style={{ display: "grid", gridTemplateColumns: "260px 1fr", gap: 24, alignItems: "start" }}>

          {/* ── LEFT: controls ── */}
          <div style={{ display: "flex", flexDirection: "column", gap: 18 }}>

            {/* Time range */}
            <div className="rvl-card" style={{ padding: 16 }}>
              <p style={{ fontSize: 11, fontWeight: 600, color: "var(--text-muted)", textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: 10 }}>Time Range</p>
              <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginBottom: 12 }}>
                {PRESETS.map(p => (
                  <button
                    key={p.from}
                    onClick={() => { setPreset(p.from); setFromCustom(""); setToCustom(""); }}
                    style={{
                      fontSize: 11, padding: "4px 10px", borderRadius: 6, cursor: "pointer",
                      border: "1px solid var(--border)",
                      background: preset === p.from && !fromCustom ? "var(--accent)" : "var(--surface-2)",
                      color: preset === p.from && !fromCustom ? "#fff" : "var(--text)",
                      fontWeight: preset === p.from && !fromCustom ? 600 : 400,
                    }}
                  >{p.label}</button>
                ))}
              </div>
              <p style={{ fontSize: 10, color: "var(--text-faint)", marginBottom: 6 }}>Custom ISO range (IST)</p>
              <input
                className="rvl-input" placeholder="From: 2026-05-13T08:00:00+05:30"
                value={fromCustom} onChange={e => setFromCustom(e.target.value)}
                style={{ width: "100%", marginBottom: 6, fontSize: 11 }}
              />
              <input
                className="rvl-input" placeholder="To: leave blank = now"
                value={toCustom} onChange={e => setToCustom(e.target.value)}
                style={{ width: "100%", fontSize: 11 }}
              />
            </div>

            {/* Tag selector */}
            <div className="rvl-card" style={{ padding: 16, maxHeight: 520, overflowY: "auto" }}>
              <p style={{ fontSize: 11, fontWeight: 600, color: "var(--text-muted)", textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: 10 }}>
                Tags ({selectedTags.length} selected)
              </p>
              {TAG_GROUPS.map(group => (
                <div key={group.label} style={{ marginBottom: 14 }}>
                  <p style={{ fontSize: 10, color: "var(--text-faint)", fontWeight: 600, marginBottom: 6, textTransform: "uppercase", letterSpacing: "0.05em" }}>{group.label}</p>
                  {group.tags.map(tag => {
                    const idx = selectedTags.indexOf(tag.slug);
                    const color = idx >= 0 ? COLORS[idx % COLORS.length] : undefined;
                    return (
                      <label key={tag.slug} style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 5, cursor: "pointer" }}>
                        <input
                          type="checkbox"
                          checked={selectedTags.includes(tag.slug)}
                          onChange={() => toggleTag(tag.slug)}
                          style={{ accentColor: color ?? "var(--accent)" }}
                        />
                        <span style={{ fontSize: 12, color: color ?? "var(--text)" }}>{tag.name}</span>
                        <span style={{ fontSize: 10, color: "var(--text-faint)", marginLeft: "auto" }}>{tag.unit}</span>
                      </label>
                    );
                  })}
                </div>
              ))}
            </div>

            <button
              onClick={fetchHistory}
              disabled={loading || selectedTags.length === 0}
              className="rvl-btn-primary"
              style={{ background: "var(--accent)", color: "#fff", border: "none", width: "100%", padding: "10px 0", fontWeight: 600, fontSize: 13, borderRadius: 8, cursor: "pointer", opacity: loading ? 0.7 : 1 }}
            >
              {loading ? "Loading…" : "Load History"}
            </button>
          </div>

          {/* ── RIGHT: chart ── */}
          <div style={{ display: "flex", flexDirection: "column", gap: 18 }}>
            {error && (
              <div style={{ background: "color-mix(in srgb, #f87171 12%, transparent)", border: "1px solid #f87171", borderRadius: 8, padding: "10px 14px", fontSize: 12, color: "#f87171" }}>
                {error}
              </div>
            )}

            {data.length > 0 ? (
              <div className="rvl-card" style={{ padding: 24 }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16 }}>
                  <div>
                    <h3 style={{ margin: 0, fontSize: 14, fontWeight: 700 }}>
                      {fetchedMeta.map(m => allTags.find(t => t.slug === m.slug)?.name ?? m.slug).join(" · ")}
                    </h3>
                    <p style={{ margin: "3px 0 0", fontSize: 11, color: "var(--text-muted)" }}>
                      {data.length} samples · {unitLabel && `Unit: ${unitLabel}`}
                    </p>
                  </div>
                  <span style={{ fontSize: 10, background: "var(--surface-2)", padding: "3px 8px", borderRadius: 4, color: "var(--text-faint)" }}>
                    {data[0]?.x ? new Date(data[0].x).toLocaleString("en-IN", { timeZone: "Asia/Kolkata" }) : ""} IST
                  </span>
                </div>

                <ResponsiveContainer width="100%" height={360}>
                  <LineChart data={data} margin={{ top: 5, right: 20, left: -5, bottom: 5 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" vertical={false} />
                    <XAxis
                      dataKey="x"
                      stroke="var(--text-muted)"
                      fontSize={10}
                      tickFormatter={val => {
                        try { return new Date(val).toLocaleTimeString("en-IN", { timeZone: "Asia/Kolkata", hour: "2-digit", minute: "2-digit" }); }
                        catch { return val; }
                      }}
                      minTickGap={40}
                    />
                    <YAxis stroke="var(--text-muted)" fontSize={10} domain={["auto", "auto"]} />
                    <Tooltip
                      contentStyle={{ background: "var(--surface-2)", border: "1px solid var(--border)", borderRadius: 8, fontSize: 12 }}
                      labelFormatter={v => new Date(v).toLocaleString("en-IN", { timeZone: "Asia/Kolkata" }) + " IST"}
                    />
                    {selectedTags.length > 1 && <Legend wrapperStyle={{ fontSize: 11, paddingTop: 10 }} />}
                    {selectedTags.map((slug, i) => (
                      <Line
                        key={slug}
                        type="monotone"
                        dataKey={slug}
                        name={allTags.find(t => t.slug === slug)?.name ?? slug}
                        stroke={COLORS[i % COLORS.length]}
                        strokeWidth={2}
                        dot={false}
                        activeDot={{ r: 4, strokeWidth: 0 }}
                        connectNulls
                      />
                    ))}
                  </LineChart>
                </ResponsiveContainer>
              </div>
            ) : (
              <div className="rvl-card" style={{ padding: 40, textAlign: "center" }}>
                <p style={{ fontSize: 24, marginBottom: 8 }}>📈</p>
                <p style={{ fontSize: 14, color: "var(--text-muted)", fontWeight: 600 }}>No data loaded yet</p>
                <p style={{ fontSize: 12, color: "var(--text-faint)", marginTop: 6 }}>
                  Select one or more tags, pick a time range, then click "Load History".
                </p>
              </div>
            )}

            {/* Stats strip */}
            {data.length > 0 && selectedTags.map((slug, i) => {
              const vals = data.map(d => d[slug]).filter((v): v is number => typeof v === "number" && !isNaN(v));
              if (!vals.length) return null;
              const min = Math.min(...vals);
              const max = Math.max(...vals);
              const avg = vals.reduce((a, b) => a + b, 0) / vals.length;
              const tagInfo = allTags.find(t => t.slug === slug);
              return (
                <div key={slug} className="rvl-card" style={{ padding: "12px 16px", borderLeft: `3px solid ${COLORS[i % COLORS.length]}` }}>
                  <p style={{ fontSize: 11, fontWeight: 600, color: COLORS[i % COLORS.length], marginBottom: 8 }}>{tagInfo?.name ?? slug}</p>
                  <div style={{ display: "flex", gap: 24 }}>
                    {[["Min", min], ["Avg", avg], ["Max", max]].map(([lbl, val]) => (
                      <div key={String(lbl)}>
                        <p style={{ fontSize: 10, color: "var(--text-faint)", margin: 0 }}>{lbl}</p>
                        <p style={{ fontSize: 16, fontWeight: 700, margin: 0 }}>{Number(val).toFixed(1)} <span style={{ fontSize: 10, opacity: 0.6 }}>{tagInfo?.unit}</span></p>
                      </div>
                    ))}
                    <div>
                      <p style={{ fontSize: 10, color: "var(--text-faint)", margin: 0 }}>Samples</p>
                      <p style={{ fontSize: 16, fontWeight: 700, margin: 0 }}>{vals.length}</p>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      </main>
    </div>
  );
}
