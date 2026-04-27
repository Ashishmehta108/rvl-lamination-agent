"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

export default function AppShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname() ?? "";

  const link = (href: string, label: string) => {
    const active = pathname === href || (href !== "/" && pathname.startsWith(href));
    return (
      <Link
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
          transition: "color .15s, background .15s, border-color .15s"
        }}
      >
        {label}
      </Link>
    );
  };

  return (
    <>
      <nav
        className="rvl-app-nav"
        style={{
          display: "flex",
          alignItems: "center",
          gap: 6,
          padding: "8px 20px",
          borderBottom: "1px solid var(--border-subtle)",
          background: "var(--surface)",
          position: "sticky",
          top: 0,
          zIndex: 30,
          boxShadow: "var(--shadow)"
        }}
        aria-label="Primary"
      >
        <span style={{ fontSize: 11, fontWeight: 700, letterSpacing: "0.08em", color: "var(--text-faint)", marginRight: 8 }}>
          RVL
        </span>
        {link("/", "Dashboard")}
        {link("/production", "Production")}
        {link("/reports", "Reports")}
        {link("/chat", "Assistant")}
      </nav>
      {children}
    </>
  );
}
