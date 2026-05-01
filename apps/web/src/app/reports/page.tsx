"use client";

import { useState, ChangeEvent, useEffect } from "react";
import useSWR from "swr";
import Link from "next/link";
import { DocumentText } from "iconsax-reactjs";

import AppHeader from "../../components/AppHeader";
import { api } from "../../lib/api";
import type { ReportRun } from "../../hooks/useDashboard";
import { useAppContext } from "../../context/AppContext";

export default function ReportsListPage() {
  const { machineId, setMachineId } = useAppContext();

  useEffect(() => {
    const m = new URLSearchParams(window.location.search).get("machineId");
    if (m) setMachineId(m);
  }, []);

  const { data, error, isLoading } = useSWR(
    ["/reports/runs", machineId, "list"],
    () => api.get<{ items: ReportRun[] }>(`/reports/runs`, { machineId, limit: "50" }),
    { refreshInterval: 15000 }
  );

  return (
    <div style={{ minHeight: "100vh", background: "var(--bg)", color: "var(--text)" }}>
      <AppHeader
        title="Reports"
        subtitle="Run history, email delivery, and in-app HTML viewer"
        icon={<DocumentText size={14} color="var(--text-muted)" />}
        rightSlot={
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <span style={{ fontSize: 11, color: "var(--text-faint)" }}>Asset</span>
            <input
              className="rvl-input"
              value={machineId}
              onChange={(e: ChangeEvent<HTMLInputElement>) => setMachineId(e.currentTarget.value)}
              style={{ width: 120 }}
            />
            <Link href="/" style={{ fontSize: 12, color: "var(--accent)" }}>
              Dashboard
            </Link>
          </div>
        }
      />

      <main style={{ maxWidth: 960, margin: "0 auto", padding: "clamp(16px, 4vw, 20px) clamp(12px, 3vw, 20px) 48px" }}>
        {isLoading && !data && <p style={{ color: "var(--text-faint)", fontSize: 13 }}>Loading…</p>}
        {error && <p style={{ color: "#c45" }}>Could not load reports.</p>}

        <div className="rvl-card" style={{ padding: 0, overflow: "hidden" }}>
          <div className="rvl-table-responsive">
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12, minWidth: 600 }}>
              <thead>
                <tr style={{ background: "var(--surface-2)", borderBottom: "1px solid var(--border-subtle)" }}>
                  <th style={{ textAlign: "left", padding: "10px 14px", fontWeight: 600, color: "var(--text-muted)" }}>Created</th>
                  <th style={{ textAlign: "left", padding: "10px 8px", fontWeight: 600, color: "var(--text-muted)" }}>Window</th>
                  <th style={{ textAlign: "left", padding: "10px 8px", fontWeight: 600, color: "var(--text-muted)" }}>Status</th>
                  <th style={{ textAlign: "right", padding: "10px 8px", fontWeight: 600, color: "var(--text-muted)" }}>Alerts</th>
                  <th style={{ textAlign: "left", padding: "10px 14px", fontWeight: 600, color: "var(--text-muted)" }}>Email</th>
                  <th style={{ textAlign: "right", padding: "10px 14px", fontWeight: 600, color: "var(--text-muted)" }}></th>
                </tr>
              </thead>
              <tbody>
                {(data?.items ?? []).map((r) => (
                  <tr key={r.id} style={{ borderBottom: "1px solid var(--border-subtle)" }}>
                    <td style={{ padding: "10px 14px", whiteSpace: "nowrap" }}>{new Date(r.createdAt).toLocaleString()}</td>
                    <td style={{ padding: "10px 8px", color: "var(--text-muted)", fontSize: 11 }}>
                      {r.windowStart && r.windowEnd
                        ? `${new Date(r.windowStart).toISOString().slice(0, 10)} → ${new Date(r.windowEnd).toISOString().slice(0, 10)}`
                        : "—"}
                    </td>
                    <td style={{ padding: "10px 8px" }}>
                      <span
                        style={{
                          fontSize: 10,
                          padding: "2px 8px",
                          borderRadius: 4,
                          background: "var(--surface-2)",
                          border: "1px solid var(--border)",
                        }}
                      >
                        {r.status}
                      </span>
                    </td>
                    <td style={{ padding: "10px 8px", textAlign: "right" }}>{r.metrics?.alerts ?? "—"}</td>
                    <td style={{ padding: "10px 14px", fontSize: 11 }}>{emailCell(r.metrics)}</td>
                    <td style={{ padding: "10px 14px", textAlign: "right" }}>
                      <Link
                        href={`/reports/${encodeURIComponent(r.id)}?machineId=${encodeURIComponent(machineId)}`}
                        style={{ color: "var(--accent)", fontWeight: 500, textDecoration: "none" }}
                      >
                        Open
                      </Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {data?.items?.length === 0 && (
            <div style={{ padding: 28, textAlign: "center", color: "var(--text-faint)" }}>No report runs yet.</div>
          )}
        </div>
      </main>
    </div>
  );
}

function emailCell(metrics: any) {
  if (!metrics || typeof metrics !== "object") return <span style={{ color: "var(--text-faint)" }}>—</span>;
  if (metrics.emailSent === true) {
    return <span style={{ color: "#22c55e" }}>Sent</span>;
  }
  if (metrics.emailError) {
    return (
      <span style={{ color: "#f87171", maxWidth: 220, display: "inline-block", overflow: "hidden", textOverflow: "ellipsis" }} title={String(metrics.emailError)}>
        Failed: {String(metrics.emailError).slice(0, 48)}
        {String(metrics.emailError).length > 48 ? "…" : ""}
      </span>
    );
  }
  if (metrics.emailQueued === false && metrics.emailEnqueueError) {
    return <span style={{ color: "#fbbf24" }}>Queue error</span>;
  }
  return <span style={{ color: "var(--text-faint)" }}>—</span>;
}
