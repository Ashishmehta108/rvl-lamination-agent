"use client";

import { useEffect, useState, useCallback } from "react";
import { useParams, useSearchParams } from "next/navigation";
import Link from "next/link";
import { DocumentText, ArrowLeft2 } from "iconsax-reactjs";

import AppHeader from "../../../components/AppHeader";
import { api } from "../../../lib/api";

type RunDetail = {
  id: string;
  status: string;
  createdAt: string;
  windowStart: string;
  windowEnd: string;
  metrics?: Record<string, unknown>;
  error?: string | null;
  machineId: string;
};

export default function ReportViewerPage() {
  const params = useParams();
  const searchParams = useSearchParams();
  const runId = decodeURIComponent(String(params.runId ?? ""));
  const machineId = searchParams.get("machineId") || "lamination-01";

  const [html, setHtml] = useState<string | null>(null);
  const [loadErr, setLoadErr] = useState<string | null>(null);
  const [run, setRun] = useState<RunDetail | null>(null);

  const fetchRun = useCallback(async () => {
    try {
      const r = await api.get<RunDetail>(`/reports/runs/${encodeURIComponent(runId)}`, { machineId });
      setRun(r);
    } catch {
      setRun(null);
    }
  }, [runId, machineId]);

  useEffect(() => {
    fetchRun();
  }, [fetchRun]);

  useEffect(() => {
    if (!runId) return;
    let cancelled = false;
    setHtml(null);
    setLoadErr(null);
    (async () => {
      try {
        const text = await api.getText(`/reports/view/${encodeURIComponent(runId)}`);
        if (!cancelled) setHtml(text);
      } catch (e: any) {
        if (!cancelled) setLoadErr(e?.message ?? "Failed to load report HTML");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [runId]);

  const downloadRaw = async () => {
    try {
      const blob = await api.getBlob(`/reports/view/${encodeURIComponent(runId)}`);
      const url = window.URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `report_${runId}.html`;
      document.body.appendChild(a);
      a.click();
      window.URL.revokeObjectURL(url);
    } catch {
      alert("Download failed");
    }
  };

  return (
    <div style={{ minHeight: "100vh", background: "var(--bg)", color: "var(--text)", display: "flex", flexDirection: "column" }}>
      <AppHeader
        title={`Report ${runId.slice(0, 12)}…`}
        subtitle={run ? `${run.status} · ${new Date(run.windowStart).toISOString().slice(0, 10)} window` : "Loading run…"}
        icon={<DocumentText size={14} color="var(--text-muted)" />}
        rightSlot={
          <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
            <Link
              href={`/reports?machineId=${encodeURIComponent(machineId)}`}
              style={{ display: "inline-flex", alignItems: "center", gap: 4, fontSize: 12, color: "var(--accent)", textDecoration: "none" }}
            >
              <ArrowLeft2 size={14} /> All reports
            </Link>
            <button type="button" className="rvl-btn-primary" style={{ fontSize: 12 }} onClick={downloadRaw}>
              Download HTML
            </button>
          </div>
        }
      />

      {run?.metrics && (
        <section className="rvl-card" style={{ margin: "0 20px 16px", maxWidth: 1100, alignSelf: "center", width: "calc(100% - 40px)", padding: "14px 16px" }}>
          <h3 style={{ margin: "0 0 10px", fontSize: 11, fontWeight: 600, letterSpacing: "0.06em", color: "var(--text-muted)", textTransform: "uppercase" }}>
            Report composition
          </h3>
          <CompositionBody metrics={run.metrics} />
        </section>
      )}

      <div style={{ flex: 1, minHeight: 400, margin: "0 20px 24px", maxWidth: 1100, width: "calc(100% - 40px)", alignSelf: "center" }}>
        {loadErr && (
          <div className="rvl-card" style={{ padding: 20, color: "#c45" }}>
            {loadErr}
          </div>
        )}
        {html && (
          <iframe
            title="Report HTML"
            srcDoc={html}
            sandbox=""
            style={{
              width: "100%",
              height: "min(78vh, 900px)",
              border: "1px solid var(--border)",
              borderRadius: 8,
              background: "#0b0f14",
            }}
          />
        )}
        {!html && !loadErr && <div className="rvl-card" style={{ padding: 24, color: "var(--text-faint)" }}>Loading report…</div>}
      </div>
    </div>
  );
}

function CompositionBody({ metrics }: { metrics: Record<string, unknown> }) {
  const fs = metrics.factsSummary as Record<string, unknown> | undefined;
  if (fs && typeof fs === "object") {
    return (
      <ul style={{ margin: 0, paddingLeft: 18, fontSize: 12, color: "var(--text-muted)", lineHeight: 1.6 }}>
        {Object.entries(fs).map(([k, v]) => (
          <li key={k}>
            <strong style={{ color: "var(--text)" }}>{k}</strong>: {typeof v === "object" ? JSON.stringify(v) : String(v)}
          </li>
        ))}
        {metrics.artifactBytes != null && (
          <li>
            <strong style={{ color: "var(--text)" }}>artifactBytes</strong>: {String(metrics.artifactBytes)}
          </li>
        )}
        {metrics.emailToCount != null && (
          <li>
            <strong style={{ color: "var(--text)" }}>emailToCount</strong>: {String(metrics.emailToCount)}
          </li>
        )}
        {metrics.emailSent != null && (
          <li>
            <strong style={{ color: "var(--text)" }}>emailSent</strong>: {String(metrics.emailSent)}
          </li>
        )}
        {metrics.emailError != null && String(metrics.emailError).length > 0 && (
          <li>
            <strong style={{ color: "var(--text)" }}>emailError</strong>: {String(metrics.emailError)}
          </li>
        )}
      </ul>
    );
  }
  return (
    <pre
      style={{
        margin: 0,
        fontSize: 11,
        overflow: "auto",
        maxHeight: 220,
        background: "var(--surface-2)",
        padding: 12,
        borderRadius: 6,
        border: "1px solid var(--border-subtle)",
      }}
    >
      {JSON.stringify(metrics, null, 2)}
    </pre>
  );
}
