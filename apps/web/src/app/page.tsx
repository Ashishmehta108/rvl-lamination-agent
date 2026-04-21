"use client";

import { useEffect, useMemo, useState } from "react";
import { LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer } from "recharts";

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

  useEffect(() => {
    let cancelled = false;
    async function load() {
      const res = await fetch(`${API}/tags/latest?machineId=${encodeURIComponent(machineId)}`, {
        headers: { Authorization: `Bearer ${TOKEN}` }
      });
      const json = await res.json();
      if (!cancelled) setItems(json.items ?? []);
    }
    load().catch(() => setItems([]));
    const t = setInterval(() => load().catch(() => {}), 3000);
    return () => {
      cancelled = true;
      clearInterval(t);
    };
  }, [machineId]);

  const series = useMemo(() => {
    const now = Date.now();
    // Minimal “sparkline-like” demo: map current latest values into a fake time axis
    return items
      .filter((i) => typeof i.valueNumber === "number")
      .slice(0, 12)
      .map((i, idx) => ({
        name: i.tagId,
        t: new Date(now - (12 - idx) * 1000).toLocaleTimeString(),
        v: i.valueNumber
      }));
  }, [items]);

  return (
    <main className="min-h-screen">
      <div className="mx-auto max-w-6xl p-6">
        <div className="flex items-end justify-between gap-4">
          <div>
            <div className="text-sm text-[#8aa0b6]">RVL Lamination Agent</div>
            <h1 className="text-2xl font-semibold">Live overview</h1>
          </div>
          <div className="flex items-center gap-2">
            <span className="text-sm text-[#8aa0b6]">Machine</span>
            <input
              className="rounded-md border border-[#1f2a36] bg-[#0f1720] px-3 py-2 text-sm outline-none"
              value={machineId}
              onChange={(e) => setMachineId(e.target.value)}
            />
          </div>
        </div>

        <div className="mt-6 grid grid-cols-1 gap-4 md:grid-cols-3">
          <div className="rounded-xl border border-[#172130] bg-[#0f1720] p-4 md:col-span-2">
            <div className="text-sm text-[#8aa0b6]">Latest numeric tags (demo chart)</div>
            <div className="mt-2 h-64">
              <ResponsiveContainer width="100%" height="100%">
                <LineChart data={series}>
                  <XAxis dataKey="t" hide />
                  <YAxis hide />
                  <Tooltip />
                  <Line type="monotone" dataKey="v" stroke="#89b4fa" dot={false} strokeWidth={2} />
                </LineChart>
              </ResponsiveContainer>
            </div>
          </div>
          <div className="rounded-xl border border-[#172130] bg-[#0f1720] p-4">
            <div className="text-sm text-[#8aa0b6]">Latest tags</div>
            <div className="mt-2 max-h-64 overflow-auto text-sm">
              {items.length === 0 ? (
                <div className="text-[#8aa0b6]">No data yet. Push to `POST /ingest/tags`.</div>
              ) : (
                <ul className="space-y-2">
                  {items.slice(0, 50).map((i) => (
                    <li key={i.tagId} className="flex items-center justify-between gap-3">
                      <span className="truncate text-[#cdd6f4]">{i.tagId}</span>
                      <span className="tabular-nums text-[#8aa0b6]">
                        {i.valueNumber ?? (i.valueBool ?? i.valueString ?? "null")}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </div>
        </div>
      </div>
    </main>
  );
}

