"use client";

import type { ChangeEvent } from "react";
import { useEffect, useMemo, useState } from "react";
import { LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer } from "recharts";
import { Activity, Flash, MessageText1, Cpu, Warning2 } from "iconsax-reactjs";
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

const API = process.env.NEXT_PUBLIC_BACKEND_URL ?? "http://127.0.0.1:7000";
const TOKEN = process.env.NEXT_PUBLIC_API_AUTH_TOKEN ?? "dev-local-token";

export default function HomePage() {
  const [machineId, setMachineId] = useState("machine_1");
  const [items, setItems] = useState<TagLatest[]>([]);
  const [error, setError] = useState(false);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const res = await fetch(`${API}/tags/latest?machineId=${encodeURIComponent(machineId)}`, {
          headers: { Authorization: `Bearer ${TOKEN}` }
        });
        const json = (await res.json()) as { items?: TagLatest[] };
        if (!cancelled) { setItems(json.items ?? []); setError(false); }
      } catch {
        if (!cancelled) setError(true);
      }
    }
    load();
    const t = setInterval(() => load(), 3000);
    return () => { cancelled = true; clearInterval(t); };
  }, [machineId]);

  const numericItems = useMemo(() => items.filter((i) => typeof i.valueNumber === "number"), [items]);

  const series = useMemo(() => {
    const now = Date.now();
    return numericItems.slice(0, 12).map((i, idx) => ({
      name: i.tagId,
      t: new Date(now - (12 - idx) * 1000).toLocaleTimeString(),
      v: i.valueNumber,
    }));
  }, [numericItems]);

  return (
    <div style={{ minHeight: "100vh", background: "var(--bg)" }}>
      <AppHeader
        title="RVL Lamination Agent"
        subtitle="Live overview"
        icon={<Cpu size={15} color="var(--accent)" variant="Bulk" />}
        rightSlot={
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <span style={{ fontSize: 12, color: "var(--text-muted)" }}>Machine</span>
            <input
              id="machine-id-input"
              value={machineId}
              onChange={(e: ChangeEvent<HTMLInputElement>) => setMachineId(e.currentTarget.value)}
              placeholder="machine_1"
              style={{
                width: 130,
                background: "var(--surface-2)",
                border: "1px solid var(--border)",
                borderRadius: 6,
                padding: "5px 10px",
                fontSize: 12,
                color: "var(--text)",
                outline: "none",
                fontFamily: "ui-monospace,'Cascadia Code',Menlo,monospace",
              }}
            />
            <a
              href="/chat"
              id="goto-chat"
              style={{
                display: "flex",
                alignItems: "center",
                gap: 6,
                fontSize: 12,
                fontWeight: 500,
                color: "var(--accent)",
                background: "var(--accent-faint)",
                border: "1px solid var(--border)",
                borderRadius: 6,
                padding: "5px 10px",
                transition: "background .15s",
              }}
              onMouseEnter={(e) => (e.currentTarget.style.background = "var(--surface-3)")}
              onMouseLeave={(e) => (e.currentTarget.style.background = "var(--accent-faint)")}
            >
              <MessageText1 size={13} color="var(--accent)" /> RAG Chat
            </a>
          </div>
        }
      />

      <main style={{ maxWidth: 900, margin: "0 auto", padding: "28px 20px 48px" }}>

        {/* ── Status strip ──────────────────────── */}
        {error && (
          <div style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            background: "var(--accent-faint)",
            border: "1px solid var(--border)",
            borderRadius: 8,
            padding: "10px 14px",
            marginBottom: 20,
            fontSize: 13,
            color: "var(--accent)",
          }}>
            <Warning2 size={15} color="var(--accent)" variant="Bulk" />
            Cannot reach backend at {API}. Is it running?
          </div>
        )}

        {/* ── Section label ─────────────────────── */}
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 16 }}>
          <Activity size={14} color="var(--text-muted)" variant="Bulk" />
          <span style={{ fontSize: 11, fontWeight: 600, letterSpacing: "0.07em", textTransform: "uppercase", color: "var(--text-muted)" }}>
            Live telemetry
          </span>
          <div style={{ flex: 1, height: 1, background: "var(--border)" }} />
          <span style={{
            fontSize: 10,
            color: "var(--text-faint)",
            background: "var(--surface-2)",
            border: "1px solid var(--border)",
            borderRadius: 4,
            padding: "2px 8px",
          }}>
            {items.length} tags · refreshes every 3s
          </span>
        </div>

        {/* ── Grid ──────────────────────────────── */}
        <div style={{ display: "grid", gridTemplateColumns: "1fr 340px", gap: 16 }}>

          {/* Chart card */}
          <div className="rvl-card" style={{ padding: "18px 20px" }}>
            <div style={{ display: "flex", alignItems: "center", gap: 7, marginBottom: 14 }}>
              <Flash size={13} color="var(--text-muted)" variant="Bulk" />
              <span style={{ fontSize: 12, fontWeight: 600, color: "var(--text-muted)" }}>Numeric tags — live</span>
            </div>
            <div style={{ height: 220 }}>
              {series.length === 0 ? (
                <div style={{
                  height: "100%",
                  display: "flex",
                  flexDirection: "column",
                  alignItems: "center",
                  justifyContent: "center",
                  gap: 8,
                  color: "var(--text-faint)",
                  fontSize: 13,
                }}>
                  <Activity size={28} color="var(--text-faint)" variant="Bulk" />
                  No numeric tags yet
                </div>
              ) : (
                <ResponsiveContainer width="100%" height="100%">
                  <LineChart data={series}>
                    <XAxis dataKey="t" hide />
                    <YAxis hide />
                    <Tooltip
                      contentStyle={{
                        background: "var(--surface)",
                        border: "1px solid var(--border)",
                        borderRadius: 6,
                        fontSize: 12,
                        color: "var(--text)",
                        boxShadow: "var(--shadow)",
                      }}
                      labelStyle={{ color: "var(--text-muted)" }}
                    />
                    <Line type="monotone" dataKey="v" stroke="var(--accent)" dot={false} strokeWidth={1.8} />
                  </LineChart>
                </ResponsiveContainer>
              )}
            </div>
          </div>

          {/* Tags list card */}
          <div className="rvl-card" style={{ padding: "18px 0", display: "flex", flexDirection: "column" }}>
            <div style={{ display: "flex", alignItems: "center", gap: 7, marginBottom: 8, padding: "0 18px" }}>
              <Cpu size={13} color="var(--text-muted)" variant="Bulk" />
              <span style={{ fontSize: 12, fontWeight: 600, color: "var(--text-muted)" }}>Latest tags</span>
            </div>
            <div style={{ flex: 1, overflowY: "auto", maxHeight: 260 }}>
              {items.length === 0 ? (
                <div style={{ padding: "24px 18px", textAlign: "center", color: "var(--text-faint)", fontSize: 13 }}>
                  No data yet.<br />
                  <span style={{ fontSize: 11 }}>POST to /ingest/tags</span>
                </div>
              ) : (
                items.slice(0, 60).map((item, i) => (
                  <div
                    key={item.tagId}
                    style={{
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "space-between",
                      gap: 8,
                      padding: "7px 18px",
                      background: i % 2 === 0 ? "transparent" : "var(--surface-2)",
                      transition: "background .12s",
                      cursor: "default",
                    }}
                    onMouseEnter={(e) => (e.currentTarget.style.background = "var(--surface-3)")}
                    onMouseLeave={(e) => (e.currentTarget.style.background = i % 2 === 0 ? "transparent" : "var(--surface-2)")}
                  >
                    <span style={{
                      fontSize: 12,
                      color: "var(--text)",
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                      fontFamily: "ui-monospace,'Cascadia Code',Menlo,monospace",
                      maxWidth: 160,
                    }}>
                      {item.tagId}
                    </span>
                    <span style={{
                      fontSize: 11,
                      fontWeight: 500,
                      color: "var(--text-muted)",
                      background: "var(--surface-3)",
                      border: "1px solid var(--border)",
                      borderRadius: 4,
                      padding: "1px 7px",
                      whiteSpace: "nowrap",
                      flexShrink: 0,
                    }}>
                      {item.valueNumber ?? (item.valueBool !== null && item.valueBool !== undefined ? String(item.valueBool) : item.valueString ?? "—")}
                    </span>
                  </div>
                ))
              )}
            </div>
          </div>
        </div>
      </main>
    </div>
  );
}
