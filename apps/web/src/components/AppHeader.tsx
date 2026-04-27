"use client";

import { useTheme } from "../lib/theme";
import { Sun1, Moon, MessageText1, ArrowLeft2 } from "iconsax-reactjs";
import type { ReactNode } from "react";

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

  return (
    <header style={{
      position: "sticky",
      top: 0,
      zIndex: 40,
      minHeight: 54,
      background: "var(--surface)",
      borderBottom: "1px solid var(--border)",
      display: "flex",
      alignItems: "center",
      justifyContent: "space-between",
      flexWrap: "wrap",
      padding: "8px 20px",
      gap: 8,
      boxShadow: "var(--shadow)",
    }}>

      {/* ── Left ──────────────────────────────────── */}
      <div style={{ display: "flex", alignItems: "center", gap: 12, minWidth: 0, flex: "1 1 180px", overflow: "hidden" }}>
        {backHref != null && (
          <>
            <a
              href={backHref}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 5,
                fontSize: 13,
                color: "var(--text-muted)",
                padding: "4px 8px",
                borderRadius: 6,
                transition: "background .15s, color .15s",
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
              <ArrowLeft2 size={13} color="currentColor" />
              {backLabel}
            </a>
            <div style={{ width: 1, height: 18, background: "var(--border)" }} />
          </>
        )}

        <div style={{ display: "flex", alignItems: "center", gap: 9, minWidth: 0 }}>
          {icon && (
            <div style={{
              width: 28,
              height: 28,
              borderRadius: 7,
              background: "var(--accent-faint)",
              border: "1px solid var(--border)",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              flexShrink: 0,
            }}>
              {icon}
            </div>
          )}
          <div style={{ minWidth: 0 }}>
            <div style={{ fontSize: 13.5, fontWeight: 600, color: "var(--text)", lineHeight: 1.15, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
              {title}
            </div>
            {subtitle && (
              <div style={{ fontSize: 10.5, color: "var(--text-muted)", lineHeight: 1.4, marginTop: 1 }}>
                {subtitle}
              </div>
            )}
          </div>
        </div>
      </div>

      {/* ── Right ─────────────────────────────────── */}
      <div className="rvl-header-right" style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", flex: "0 1 auto" }}>
        {rightSlot}

        {/* Theme toggle */}
        <button
          id="theme-toggle"
          onClick={toggle}
          title={`Switch to ${theme === "light" ? "dark" : "light"} mode`}
          style={{
            width: 32,
            height: 32,
            borderRadius: 7,
            border: "1px solid var(--border)",
            background: "var(--surface-2)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            cursor: "pointer",
            color: "var(--text-muted)",
            transition: "background .15s, border-color .15s",
          }}
          onMouseEnter={(e) => {
            (e.currentTarget as HTMLElement).style.background = "var(--surface-3)";
          }}
          onMouseLeave={(e) => {
            (e.currentTarget as HTMLElement).style.background = "var(--surface-2)";
          }}
        >
          {theme === "light"
            ? <Moon size={14} color="var(--text-muted)" variant="Bulk" />
            : <Sun1 size={14} color="var(--text-muted)" variant="Bulk" />
          }
        </button>
      </div>
    </header>
  );
}
