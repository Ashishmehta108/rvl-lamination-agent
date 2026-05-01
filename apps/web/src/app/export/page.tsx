"use client";

import { useState, useMemo } from "react";
import { ExportCurve, Calendar, Cpu, TickCircle, CloseCircle } from "iconsax-reactjs";
import AppHeader from "../../components/AppHeader";
import { useAppContext } from "../../context/AppContext";
import { useDashboard } from "../../hooks/useDashboard";
import { toast } from "sonner";

export default function ExportPage() {
  const { machineId, setMachineId } = useAppContext();
  const { items, isLoading } = useDashboard(machineId);

  const [startDate, setStartDate] = useState(() => {
    const d = new Date();
    d.setHours(d.getHours() - 24);
    return d.toISOString().slice(0, 16);
  });
  const [endDate, setEndDate] = useState(() => new Date().toISOString().slice(0, 16));
  const [selectedTags, setSelectedTags] = useState<string[]>([]);
  const [isExporting, setIsExporting] = useState(false);

  const tags = useMemo(() => {
    // Deduplicate and sort tags
    const map = new Map<string, string>();
    items.forEach(item => {
      const slug = item.slug || item.tagId;
      const name = item.name || slug;
      map.set(slug, name);
    });
    return Array.from(map.entries()).sort((a, b) => a[1].localeCompare(b[1]));
  }, [items]);

  const toggleTag = (slug: string) => {
    setSelectedTags(prev => 
      prev.includes(slug) ? prev.filter(s => s !== slug) : [...prev, slug]
    );
  };

  const handleExport = async () => {
    if (!startDate || !endDate) {
      toast.error("Please select a valid date range");
      return;
    }

    const tid = toast.loading("Preparing CSV export...");
    setIsExporting(true);

    try {
      const params = new URLSearchParams({
        machineId,
        from: new Date(startDate).toISOString(),
        to: new Date(endDate).toISOString()
      });

      if (selectedTags.length > 0) {
        params.append("tags", selectedTags.join(","));
      }

      // We trigger download by opening the proxy URL directly
      const url = `/api/proxy/metrics/production/samples?${params.toString()}`;
      
      // Since it's a file download response from the backend, we can just use window.location or an <a> tag
      const a = document.createElement("a");
      a.href = url;
      a.download = `export-${machineId}-${new Date().getTime()}.csv`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);

      toast.success("Export started", { id: tid });
    } catch (err: any) {
      toast.error("Export failed", { id: tid, description: err.message });
    } finally {
      setIsExporting(false);
    }
  };

  return (
    <div style={{ minHeight: "100vh", background: "var(--bg)", color: "var(--text)" }}>
      <AppHeader
        title="Data Export"
        subtitle="Extract historical sensor telemetry to CSV/Excel"
        icon={<ExportCurve size={14} color="var(--accent)" variant="Bulk" />}
      />

      <main style={{ maxWidth: 800, margin: "0 auto", padding: "clamp(16px, 4vw, 32px) clamp(12px, 3vw, 24px) 60px" }}>
        <div style={{ display: "grid", gap: 24 }}>
          
          {/* ── Settings Card ── */}
          <div className="rvl-card" style={{ padding: 24 }}>
            <h2 style={{ fontSize: 14, fontWeight: 600, marginBottom: 20, color: "var(--text-muted)", display: "flex", alignItems: "center", gap: 8 }}>
              <Cpu size={16} /> 1. Configuration
            </h2>
            
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))", gap: 20 }}>
              <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                <label style={{ fontSize: 11, fontWeight: 600, color: "var(--text-faint)", textTransform: "uppercase" }}>Machine ID</label>
                <input 
                  className="rvl-input"
                  value={machineId}
                  onChange={(e) => setMachineId(e.target.value)}
                  placeholder="e.g. lamination-01"
                />
              </div>

              <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                <label style={{ fontSize: 11, fontWeight: 600, color: "var(--text-faint)", textTransform: "uppercase" }}>Time Range</label>
                <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                  <input 
                    type="datetime-local"
                    className="rvl-input"
                    value={startDate}
                    onChange={(e) => setStartDate(e.target.value)}
                    style={{ flex: 1 }}
                  />
                  <span style={{ color: "var(--text-faint)" }}>→</span>
                  <input 
                    type="datetime-local"
                    className="rvl-input"
                    value={endDate}
                    onChange={(e) => setEndDate(e.target.value)}
                    style={{ flex: 1 }}
                  />
                </div>
              </div>
            </div>
          </div>

          {/* ── Tag Selection Card ── */}
          <div className="rvl-card" style={{ padding: 24 }}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 20 }}>
              <h2 style={{ fontSize: 14, fontWeight: 600, margin: 0, color: "var(--text-muted)", display: "flex", alignItems: "center", gap: 8 }}>
                <Calendar size={16} /> 2. Select Sensors
              </h2>
              <div style={{ display: "flex", gap: 8 }}>
                <button 
                  onClick={() => setSelectedTags(tags.map(t => t[0]))}
                  style={{ fontSize: 11, background: "none", border: "none", color: "var(--accent)", cursor: "pointer", fontWeight: 500 }}
                >
                  Select All
                </button>
                <button 
                  onClick={() => setSelectedTags([])}
                  style={{ fontSize: 11, background: "none", border: "none", color: "var(--text-faint)", cursor: "pointer", fontWeight: 500 }}
                >
                  Clear
                </button>
              </div>
            </div>

            {isLoading && <p style={{ fontSize: 13, color: "var(--text-faint)" }}>Loading machine tags…</p>}
            
            <div style={{ 
              display: "grid", 
              gridTemplateColumns: "repeat(auto-fill, minmax(180px, 1fr))", 
              gap: 8,
              maxHeight: 300,
              overflowY: "auto",
              paddingRight: 8,
              marginTop: 10
            }} className="rvl-scroll-hidden">
              {tags.map(([slug, name]) => {
                const active = selectedTags.includes(slug);
                return (
                  <button
                    key={slug}
                    onClick={() => toggleTag(slug)}
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 8,
                      padding: "8px 12px",
                      borderRadius: 8,
                      background: active ? "var(--accent-faint)" : "var(--surface-2)",
                      border: `1px solid ${active ? "var(--accent)" : "var(--border)"}`,
                      textAlign: "left",
                      cursor: "pointer",
                      transition: "all .15s ease",
                    }}
                  >
                    {active ? <TickCircle size={14} color="var(--accent)" variant="Bold" /> : <div style={{ width: 14, height: 14, borderRadius: "50%", border: "1px solid var(--border)" }} />}
                    <span style={{ fontSize: 12, fontWeight: active ? 600 : 400, color: active ? "var(--text)" : "var(--text-muted)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                      {name}
                    </span>
                  </button>
                );
              })}
            </div>
            
            <div style={{ marginTop: 20, padding: "12px 16px", background: "var(--bg)", borderRadius: 8, border: "1px dashed var(--border)", fontSize: 12, color: "var(--text-faint)" }}>
              {selectedTags.length === 0 
                ? "No sensors selected. Exporting default production metrics (RPM, MPM, GSM)." 
                : `${selectedTags.length} sensors selected for export.`
              }
            </div>
          </div>

          {/* ── Action ── */}
          <div style={{ display: "flex", justifyContent: "flex-end" }}>
            <button
              onClick={handleExport}
              disabled={isExporting}
              className="rvl-btn-primary"
              style={{
                background: "var(--accent)",
                color: "#fff",
                border: "none",
                padding: "14px 28px",
                borderRadius: 10,
                fontSize: 14,
                fontWeight: 600,
                display: "flex",
                alignItems: "center",
                gap: 10,
                boxShadow: "0 8px 20px -6px color-mix(in srgb, var(--accent) 30%, transparent)",
                cursor: isExporting ? "not-allowed" : "pointer",
                opacity: isExporting ? 0.7 : 1
              }}
            >
              <ExportCurve size={18} variant="Bulk" />
              {isExporting ? "Exporting…" : "Download CSV Data"}
            </button>
          </div>

        </div>
      </main>
    </div>
  );
}
