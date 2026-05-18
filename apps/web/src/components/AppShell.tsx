"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Home, Chart, DocumentText, MessageText } from "iconsax-reactjs";

const NAV_LINKS = [
  { href: "/", label: "Dashboard", icon: (a: boolean) => <Home size={20} variant={a ? "Bulk" : "Linear"} /> },
  { href: "/production", label: "Production", icon: (a: boolean) => <Chart size={20} variant={a ? "Bulk" : "Linear"} /> },
  { href: "/reports", label: "Reports", icon: (a: boolean) => <DocumentText size={20} variant={a ? "Bulk" : "Linear"} /> },
  { href: "/chat", label: "Assistant", icon: (a: boolean) => <MessageText size={20} variant={a ? "Bulk" : "Linear"} /> },
];

export default function AppShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname() ?? "";
  const { 
    machineId, setMachineId, 
    isGeneratingReport, triggerReport, 
    menuOpen, setMenuOpen 
  } = useAppContext();

  const isActive = (href: string) =>
    href === "/" ? pathname === "/" : pathname === href || pathname.startsWith(href);

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100dvh", overflow: "hidden" }}>

      {/* ─── Desktop top navbar (md+) ─── */}
      <nav
        aria-label="Primary"
        className="hidden md:flex"
        style={{
          alignItems: "center",
          justifyContent: "space-between",
          padding: "8px 20px",
          borderBottom: "1px solid var(--border-subtle)",
          background: "var(--surface)",
          position: "sticky",
          top: 0,
          zIndex: 30,
          boxShadow: "var(--shadow)",
          flexShrink: 0,
        }}
      >
        <span style={{
          fontSize: 11, fontWeight: 700,
          letterSpacing: "0.08em", color: "var(--text-faint)",
        }}>
          RVL
        </span>

        <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
          {NAV_LINKS.map(({ href, label }) => {
            const active = isActive(href);
            return (
              <Link
                key={href}
                href={href}
                prefetch
                style={{
                  fontSize: 12,
                  fontWeight: active ? 600 : 500,
                  color: active ? "var(--text)" : "var(--text-muted)",
                  textDecoration: "none",
                  padding: "6px 12px",
                  borderRadius: 6,
                  background: active ? "var(--surface-2)" : "transparent",
                  border: `1px solid ${active ? "var(--border)" : "transparent"}`,
                  transition: "color .15s, background .15s, border-color .15s",
                }}
              >
                {label}
              </Link>
            );
          })}
        </div>
      </nav>

      {/* ─── Page content ─── */}
      {/* pb-[60px] on mobile ensures content never hides behind the bottom nav */}
      <div
        className="pb-[60px] md:pb-0"
        style={{ flex: 1, display: "flex", flexDirection: "column", minHeight: 0, overflowY: "auto" }}
      >
        {children}
      </div>
      <nav
        aria-label="Mobile navigation"
        className="md:hidden flex"
        style={{
          position: "fixed",
          bottom: 0, left: 0, right: 0,
          zIndex: 60,
          height: 60,
          // ❌ removed: display: "flex"  ← was overriding md:hidden
          background: "var(--surface)",
          borderTop: "1px solid var(--border)",
          paddingBottom: "env(safe-area-inset-bottom)",
        }}
      >
        {NAV_LINKS.map(({ href, label, icon }) => {
          const active = isActive(href);
          return (
            <Link
              key={href}
              href={href}
              prefetch
              style={{
                flex: 1,
                display: "flex",
                flexDirection: "column",
                alignItems: "center",
                justifyContent: "center",
                gap: 3,
                textDecoration: "none",
                color: active ? "var(--accent)" : "var(--text-faint)",
                fontSize: 10,
                fontWeight: active ? 600 : 400,
                transition: "color .15s",
              }}
            >
              {icon(active)}
              {label}
            </Link>
          );
        })}
      </nav>

    </div>
  );
}