"use client";

import { useEffect, useState, useCallback } from "react";
import { useParams, useSearchParams } from "next/navigation";
import Link from "next/link";
import { DocumentText, ArrowLeft2, DocumentDownload } from "iconsax-reactjs";

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
    <div style={{ height: "100dvh", background: "var(--bg)", color: "var(--text)", display: "flex", flexDirection: "column", overflow: "hidden" }}>
      <AppHeader
        title={`Report ${runId.slice(0, 12)}…`}
        subtitle={run ? `${run.status.charAt(0).toUpperCase() + run.status.slice(1)} · ${new Date(run.windowStart).toLocaleDateString(undefined, { month: "short", day: "numeric" })} window` : "Loading run…"}
        icon={<DocumentText size={14} color="var(--accent)" variant="Bulk" />}
        rightSlot={
          <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
            <Link
              href={`/reports?machineId=${encodeURIComponent(machineId)}`}
              style={{ display: "inline-flex", alignItems: "center", gap: 4, fontSize: 12, color: "var(--text-muted)", textDecoration: "none", transition: "color .15s" }}
              onMouseEnter={(e) => e.currentTarget.style.color = "var(--text)"}
              onMouseLeave={(e) => e.currentTarget.style.color = "var(--text-muted)"}
            >
              <ArrowLeft2 size={14} /> Back to List
            </Link>
            <div style={{ width: 1, height: 16, background: "var(--border)" }} />
            <button type="button" className="rvl-btn-primary" onClick={downloadRaw}>
              <DocumentDownload size={14} /> Download HTML
            </button>
          </div>
        }
      />

      <div style={{ flex: 1, display: "flex", flexDirection: "column", padding: "24px 20px 0", maxWidth: 1000, margin: "0 auto", width: "100%", overflow: "hidden" }}>
        {loadErr && (
          <div className="rvl-card" style={{ padding: 20, color: "#dc2626", marginBottom: 20 }}>
            {loadErr}
          </div>
        )}
        
        {!html && !loadErr ? (
           <div className="rvl-card" style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center", color: "var(--text-faint)", marginBottom: 24 }}>
             <span style={{ animation: "rvl-flash 2s infinite" }}>Loading report…</span>
           </div>
        ) : html ? (
          <div className="rvl-card" style={{ flex: 1, padding: 0, overflow: "hidden", borderBottomLeftRadius: 0, borderBottomRightRadius: 0, borderBottom: "none" }}>
            <iframe
              title="Report HTML"
              srcDoc={html}
              sandbox=""
              style={{
                width: "100%",
                height: "100%",
                border: "none",
                background: "transparent",
                display: "block"
              }}
            />
          </div>
        ) : null}
      </div>
    </div>
  );
}
