"use client";
 
import { useTheme } from "../lib/theme";
import { Sun1, Moon, ArrowLeft2, Menu, CloseSquare } from "iconsax-reactjs";
import type { ReactNode } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useAppContext } from "../context/AppContext";

interface AppHeaderProps {
  /** Back link — pass null to hide */
  backHref?: string | null;
  backLabel?: string;
  /** Left title area */
  icon?: ReactNode;
  title: string;
  subtitle?: string;
  /** Slot rendered to the right of the theme toggle */
  rightSlot?: ReactNode;
}

export default function AppHeader({
  backHref,
  backLabel = "Overview",
  icon,
  title,
  subtitle,
  rightSlot,
}: AppHeaderProps) {
  const { theme, toggle } = useTheme();
  const pathname = usePathname() ?? "";
  const { menuOpen, setMenuOpen } = useAppContext();

  const navLink = (href: string, label: string) => {
    const active = pathname === href || (href !== "/" && pathname.startsWith(href));
    return (
      <Link
        href={href}
        style={{
          fontSize: 12,
          fontWeight: active ? 600 : 500,
          color: active ? "var(--text)" : "var(--text-muted)",
          textDecoration: "none",
          padding: "6px 10px",
          borderRadius: 6,
          background: active ? "var(--surface-2)" : "transparent",
          transition: "all .15s ease",
          whiteSpace: "nowrap"
        }}
        onMouseEnter={(e) => {
          if (!active) (e.currentTarget as HTMLElement).style.background = "var(--surface-2)";
        }}
        onMouseLeave={(e) => {
          if (!active) (e.currentTarget as HTMLElement).style.background = "transparent";
        }}
      >
        {label}
      </Link>
    );
  };

  return (
    <header 
      style={{
        position: "sticky",
        top: 0,
        zIndex: 100,
        height: 56,
        borderBottom: "1px solid var(--border)",
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        padding: "0 clamp(12px, 3vw, 24px)",
        background: "rgba(var(--surface-rgb), 0.8)",
        backdropFilter: "blur(12px)",
        WebkitBackdropFilter: "blur(12px)",
        boxShadow: "0 1px 3px rgba(0,0,0,0.05)",
      }}
    >
      {/* ── Left Section: Logo + Divider + Title ───────────────── */}
      <div style={{ display: "flex", alignItems: "center", gap: 12, minWidth: 0, flexShrink: 1 }}>
        <Link href="/" style={{ display: "flex", alignItems: "center", textDecoration: "none", flexShrink: 0 }}>
          <span style={{ fontSize: 13, fontWeight: 900, letterSpacing: "0.1em", color: "var(--accent)" }}>
            RVL
          </span>
        </Link>

        <div style={{ width: 1, height: 20, background: "var(--border)", flexShrink: 0 }} />

        {backHref != null && (
          <Link
            href={backHref}
            style={{
              display: "flex",
              alignItems: "center",
              gap: 5,
              fontSize: 12,
              fontWeight: 500,
              color: "var(--text-muted)",
              padding: "4px 8px",
              borderRadius: 6,
              transition: "all .15s ease",
              flexShrink: 0
            }}
            onMouseEnter={(e) => {
              (e.currentTarget as HTMLElement).style.background = "var(--surface-2)";
              (e.currentTarget as HTMLElement).style.color = "var(--text)";
            }}
            onMouseLeave={(e) => {
              (e.currentTarget as HTMLElement).style.background = "transparent";
              (e.currentTarget as HTMLElement).style.color = "var(--text-muted)";
            }}
          >
            <ArrowLeft2 size={14} />
            <span className="rvl-hide-mobile">{backLabel}</span>
          </Link>
        )}

        <div style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 0 }}>
          {icon && (
            <div className="rvl-hide-mobile" style={{
              width: 24, height: 24, borderRadius: 6,
              background: "var(--accent-faint)", border: "1px solid var(--border)",
              display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0,
            }}>
              {icon}
            </div>
          )}
          <div style={{ minWidth: 0 }}>
            <h1 style={{ 
              fontSize: "clamp(13px, 3.5vw, 15px)", 
              fontWeight: 700, 
              color: "var(--text)", 
              lineHeight: 1.1, 
              margin: 0,
              whiteSpace: "nowrap", 
              overflow: "hidden", 
              textOverflow: "ellipsis" 
            }}>
              {title}
            </h1>
            {subtitle && (
              <p className="rvl-hide-mobile" style={{ 
                fontSize: 10, 
                color: "var(--text-faint)", 
                margin: "2px 0 0",
                whiteSpace: "nowrap", 
                overflow: "hidden", 
                textOverflow: "ellipsis" 
              }}>
                {subtitle}
              </p>
            )}
          </div>
        </div>
      </div>

      {/* ── Center/Right Section: Nav + Actions + Theme ───────── */}
      <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
        {/* Desktop Navigation */}
        <nav className="rvl-hide-mobile" style={{ display: "flex", alignItems: "center", gap: 4, marginRight: 8 }}>
          {navLink("/", "Dashboard")}
          {navLink("/production", "Production")}
          {navLink("/reports", "Reports")}
          {navLink("/export", "Export")}
          {navLink("/chat", "Assistant")}
        </nav>

        {/* Dynamic Actions Slot */}
        {rightSlot && (
          <div className="rvl-hide-mobile" style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <div style={{ width: 1, height: 20, background: "var(--border)", marginRight: 4 }} />
            {rightSlot}
          </div>
        )}

        {/* Theme Toggle */}
        <button
          onClick={toggle}
          title={`Switch to ${theme === "light" ? "dark" : "light"} mode`}
          style={{
            width: 34, height: 34, borderRadius: 8,
            border: "1px solid var(--border)",
            background: "var(--surface-2)",
            display: "flex", alignItems: "center", justifyContent: "center",
            cursor: "pointer", color: "var(--text-muted)", transition: "all .15s ease",
          }}
          onMouseEnter={(e) => (e.currentTarget.style.background = "var(--surface-3)")}
          onMouseLeave={(e) => (e.currentTarget.style.background = "var(--surface-2)")}
        >
          {theme === "light" 
            ? <Moon size={16} variant="Bulk" /> 
            : <Sun1 size={16} variant="Bulk" />
          }
        </button>

        {/* Mobile Menu Trigger */}
        <button
          className="rvl-show-mobile-flex"
          onClick={() => setMenuOpen(!menuOpen)}
          style={{
            display: "none", width: 34, height: 34, borderRadius: 8,
            border: "1px solid var(--border)",
            background: "var(--surface-2)",
            alignItems: "center", justifyContent: "center",
            cursor: "pointer", color: "var(--text-muted)",
          }}
        >
          {menuOpen ? <CloseSquare size={18} variant="Bulk" /> : <Menu size={18} variant="Bulk" />}
        </button>
      </div>
    </header>
  );
}
