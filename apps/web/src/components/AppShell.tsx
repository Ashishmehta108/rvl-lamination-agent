"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { CloseSquare, DocumentText, Cpu } from "iconsax-reactjs";
import { useAppContext } from "../context/AppContext";

export default function AppShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname() ?? "";
  const { 
    machineId, setMachineId, 
    isGeneratingReport, triggerReport, 
    menuOpen, setMenuOpen 
  } = useAppContext();

  const link = (href: string, label: string) => {
    const active = pathname === href || (href !== "/" && pathname.startsWith(href));
    return (
      <Link
        href={href}
        prefetch
        onClick={() => setMenuOpen(false)}
        style={{
          fontSize: 14,
          fontWeight: active ? 600 : 500,
          color: active ? "var(--text)" : "var(--text-muted)",
          textDecoration: "none",
          padding: "10px 14px",
          borderRadius: 8,
          background: active ? "var(--surface-2)" : "transparent",
          border: `1px solid ${active ? "var(--border)" : "transparent"}`,
          transition: "all .15s ease",
          display: "flex",
          alignItems: "center",
          gap: 10
        }}
      >
        {label}
      </Link>
    );
  };

  return (
    <>
      {/* Mobile Menu Overlay */}
      {menuOpen && (
        <div style={{
          position: "fixed", inset: 0, top: 56, zIndex: 100, 
          background: "rgba(var(--surface-rgb), 0.98)", 
          backdropFilter: "blur(12px)",
          padding: "24px 20px",
          display: "flex", flexDirection: "column", gap: 28, 
          animation: "rvl-fadein .2s ease"
        }}>
          {/* Navigation Links */}
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            <span style={{ fontSize: 10, fontWeight: 700, color: "var(--text-faint)", textTransform: "uppercase", letterSpacing: "0.08em", marginBottom: 4 }}>Navigation</span>
            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              {link("/", "Dashboard")}
              {link("/production", "Production")}
              {link("/reports", "Reports")}
              {link("/export", "Export")}
              {link("/chat", "Assistant")}
            </div>
          </div>

          {/* Machine Actions (Mobile) */}
          <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
              <span style={{ fontSize: 10, fontWeight: 700, color: "var(--text-faint)", textTransform: "uppercase", letterSpacing: "0.08em" }}>Asset Management</span>
              <button 
                onClick={() => setMenuOpen(false)}
                style={{ background: "none", border: "none", color: "var(--text-faint)", cursor: "pointer" }}
              >
                <CloseSquare size={18} />
              </button>
            </div>
            
            <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 12, background: "var(--surface)", border: "1px solid var(--border)", padding: "12px 16px", borderRadius: 10 }}>
                <Cpu size={18} color="var(--text-muted)" />
                <div style={{ display: "flex", flexDirection: "column", gap: 2, flex: 1 }}>
                   <span style={{ fontSize: 10, color: "var(--text-faint)" }}>Active Machine</span>
                   <input 
                    className="rvl-input" 
                    value={machineId}
                    onChange={(e) => setMachineId(e.target.value)}
                    style={{ border: "none", padding: 0, background: "none", fontSize: 15, fontWeight: 600, width: "100%" }}
                   />
                </div>
              </div>
              <button 
                onClick={() => { triggerReport(); setMenuOpen(false); }} 
                disabled={isGeneratingReport}
                className="rvl-btn-primary" 
                style={{ background: "var(--accent)", color: "#fff", border: "none", padding: "14px", justifyContent: "center", fontSize: 14, borderRadius: 10 }}
              >
                <DocumentText size={18} />
                {isGeneratingReport ? "Processing…" : "Run Report Now"}
              </button>
            </div>
          </div>
        </div>
      )}

      <div style={{ minHeight: "100vh", display: "flex", flexDirection: "column" }}>
        {children}
      </div>
    </>
  );
}
