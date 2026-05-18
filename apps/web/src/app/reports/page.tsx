"use client";

import { useState, ChangeEvent, useEffect } from "react";
import useSWR from "swr";
import Link from "next/link";
import { DocumentText, ArrowRight2 } from "iconsax-reactjs";

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
        subtitle="Run history and email delivery logs"
        icon={<DocumentText size={14} color="var(--accent)" variant="Bulk" />}
        rightSlot={
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <span style={{ fontSize: 11, color: "var(--text-faint)" }}>Asset</span>
            <input
              className="rvl-input"
              value={machineId}
              onChange={(e: ChangeEvent<HTMLInputElement>) => setMachineId(e.currentTarget.value)}
              style={{ width: 120 }}
            />
            <Link href="/" className="rvl-btn-primary" style={{ textDecoration: "none" }}>
              Dashboard
            </Link>
          </div>
        }
      />

      <main style={{ maxWidth: 1000, margin: "0 auto", padding: "32px 20px 48px" }}>
        {isLoading && !data && <p style={{ color: "var(--text-faint)", fontSize: 13, textAlign: "center", padding: 40 }}>Loading reports…</p>}
        {error && <p style={{ color: "#ef4444", textAlign: "center", padding: 40 }}>Could not load reports.</p>}

        {data && (
          <div className="rvl-card" style={{ padding: 0, overflow: "hidden", border: "1px solid var(--border)" }}>
            <div style={{ overflowX: "auto" }}>
              <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
                <thead>
                  <tr style={{ background: "var(--surface-2)", borderBottom: "1px solid var(--border)", textTransform: "uppercase", fontSize: 11, letterSpacing: "0.04em" }}>
                    <th style={{ textAlign: "left", padding: "14px 20px", fontWeight: 600, color: "var(--text-muted)" }}>Created</th>
                    <th style={{ textAlign: "left", padding: "14px 16px", fontWeight: 600, color: "var(--text-muted)" }}>Window</th>
                    <th style={{ textAlign: "left", padding: "14px 16px", fontWeight: 600, color: "var(--text-muted)" }}>Status</th>
                    <th style={{ textAlign: "right", padding: "14px 16px", fontWeight: 600, color: "var(--text-muted)" }}>Alerts</th>
                    <th style={{ textAlign: "left", padding: "14px 20px", fontWeight: 600, color: "var(--text-muted)" }}>Email</th>
                    <th style={{ textAlign: "right", padding: "14px 20px", fontWeight: 600, color: "var(--text-muted)" }}></th>
                  </tr>
                </thead>
                <tbody>
                  {(data.items ?? []).map((r) => (
                    <tr key={r.id} style={{ borderBottom: "1px solid var(--border-subtle)", transition: "background .15s" }} onMouseEnter={(e) => e.currentTarget.style.background = "var(--surface-2)"} onMouseLeave={(e) => e.currentTarget.style.background = "transparent"}>
                      <td style={{ padding: "14px 20px", whiteSpace: "nowrap", color: "var(--text)", fontWeight: 500 }}>
                        {new Date(r.createdAt).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}
                      </td>
                      <td style={{ padding: "14px 16px", color: "var(--text-muted)", fontSize: 12 }}>
                        {r.windowStart && r.windowEnd
                          ? `${new Date(r.windowStart).toLocaleDateString(undefined, { month: "short", day: "numeric" })} → ${new Date(r.windowEnd).toLocaleDateString(undefined, { month: "short", day: "numeric" })}`
                          : "—"}
                      </td>
                      <td style={{ padding: "14px 16px" }}>
                        <span
                          style={{
                            fontSize: 11,
                            padding: "3px 8px",
                            borderRadius: 6,
                            background: r.status === "succeeded" ? "color-mix(in srgb, #22c55e 12%, transparent)" : r.status === "failed" ? "color-mix(in srgb, #ef4444 12%, transparent)" : "var(--surface-3)",
                            color: r.status === "succeeded" ? "#16a34a" : r.status === "failed" ? "#dc2626" : "var(--text-muted)",
                            fontWeight: 500,
                            textTransform: "capitalize"
                          }}
                        >
                          {r.status}
                        </span>
                      </td>
                      <td style={{ padding: "14px 16px", textAlign: "right", color: "var(--text)" }}>{r.metrics?.alerts ?? r.metrics?.totalAlerts ?? "—"}</td>
                      <td style={{ padding: "14px 20px", fontSize: 12 }}>{emailCell(r.metrics)}</td>
                      <td style={{ padding: "14px 20px", textAlign: "right" }}>
                        <Link
                          href={`/reports/${encodeURIComponent(r.id)}?machineId=${encodeURIComponent(machineId)}`}
                          style={{ color: "var(--accent)", fontWeight: 600, textDecoration: "none", display: "inline-flex", alignItems: "center", gap: 4 }}
                        >
                          View <ArrowRight2 size={12} />
                        </Link>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {data.items?.length === 0 && (
              <div style={{ padding: 48, textAlign: "center", color: "var(--text-faint)", fontSize: 14 }}>No report runs yet.</div>
            )}
          </div>
        )}
      </main>
    </div>
  );
}

function emailCell(metrics: any) {
  if (!metrics || typeof metrics !== "object") return <span style={{ color: "var(--text-faint)" }}>—</span>;
  if (metrics.emailSent === true) {
    return <span style={{ color: "#16a34a", fontWeight: 500 }}>Sent</span>;
  }
  if (metrics.emailError) {
    return (
      <span style={{ color: "#dc2626", maxWidth: 220, display: "inline-block", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", verticalAlign: "bottom" }} title={String(metrics.emailError)}>
        Failed: {String(metrics.emailError)}
      </span>
    );
  }
  if (metrics.emailQueued === false && metrics.emailEnqueueError) {
    return <span style={{ color: "#d97706" }}>Queue error</span>;
  }
  return <span style={{ color: "var(--text-faint)" }}>—</span>;
}
