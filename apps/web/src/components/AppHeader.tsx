"use client";
 
import { useTheme } from "../lib/theme";
import { Sun1, Moon, ArrowLeft2 } from "iconsax-reactjs";
import type { ReactNode } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useAppContext } from "../context/AppContext";

interface AppHeaderProps {
  backHref?: string | null;
  backLabel?: string;
  icon?: ReactNode;
  title: string;
  subtitle?: string;
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
    <>
      <style>{`
        .rvl-header {
          position: sticky;
          top: 0;
          z-index: 40;
          min-height: 52px;
          background: var(--surface);
          border-bottom: 1px solid var(--border);
          display: flex;
          align-items: center;
          justify-content: space-between;
          padding: 8px 20px;
          gap: 8px;
          box-shadow: var(--shadow);
        }

        .rvl-header-left {
          display: flex;
          align-items: center;
          gap: 10px;
          min-width: 0;
          flex: 1 1 0;
          overflow: hidden;
        }

        .rvl-header-back {
          display: flex;
          align-items: center;
          gap: 5px;
          font-size: 12px;
          color: var(--text-muted);
          padding: 4px 8px;
          border-radius: 6px;
          text-decoration: none;
          white-space: nowrap;
          flex-shrink: 0;
          transition: background .15s, color .15s;
        }
        .rvl-header-back:hover {
          background: var(--surface-2);
          color: var(--text);
        }

        .rvl-header-divider {
          width: 1px;
          height: 18px;
          background: var(--border);
          flex-shrink: 0;
        }

        .rvl-header-title-group {
          display: flex;
          align-items: center;
          gap: 9px;
          min-width: 0;
          flex: 1 1 0;
          overflow: hidden;
        }

        .rvl-header-icon {
          width: 28px;
          height: 28px;
          border-radius: 7px;
          background: var(--accent-faint);
          border: 1px solid var(--border);
          display: flex;
          align-items: center;
          justify-content: center;
          flex-shrink: 0;
        }

        .rvl-header-text {
          min-width: 0;
          overflow: hidden;
        }

        .rvl-header-name {
          font-size: 13.5px;
          font-weight: 600;
          color: var(--text);
          line-height: 1.2;
          white-space: nowrap;
          overflow: hidden;
          text-overflow: ellipsis;
        }

        .rvl-header-sub {
          font-size: 10.5px;
          color: var(--text-muted);
          line-height: 1.4;
          margin-top: 1px;
          white-space: nowrap;
          overflow: hidden;
          text-overflow: ellipsis;
        }

        .rvl-header-right {
          display: flex;
          align-items: center;
          gap: 6px;
          flex-shrink: 0;
        }

        .rvl-theme-btn {
          width: 32px;
          height: 32px;
          border-radius: 7px;
          border: 1px solid var(--border);
          background: var(--surface-2);
          display: flex;
          align-items: center;
          justify-content: center;
          cursor: pointer;
          color: var(--text-muted);
          transition: background .15s, border-color .15s;
          flex-shrink: 0;
        }
        .rvl-theme-btn:hover { background: var(--surface-3); }

        /* On small screens: hide back label text, keep icon */
        @media (max-width: 480px) {
          .rvl-header {
            padding: 8px 14px;
          }
          .rvl-back-label {
            display: none;
          }
          .rvl-header-back {
            padding: 4px 6px;
          }
          .rvl-header-name {
            font-size: 13px;
          }
        }

        /* Shrink right slot items on small screens */
        @media (max-width: 600px) {
          .rvl-header-right {
            gap: 4px;
          }
        }
      `}</style>

      <header className="rvl-header">

        {/* ── Left ── */}
        <div className="rvl-header-left">
          {backHref != null && (
            <>
              <a href={backHref} className="rvl-header-back">
                <ArrowLeft2 size={13} color="currentColor" />
                <span className="rvl-back-label">{backLabel}</span>
              </a>
              <div className="rvl-header-divider" />
            </>
          )}

          <div className="rvl-header-title-group">
            {icon && <div className="rvl-header-icon">{icon}</div>}
            <div className="rvl-header-text">
              <div className="rvl-header-name">{title}</div>
              {subtitle && <div className="rvl-header-sub">{subtitle}</div>}
            </div>
          </div>
        </div>

        {/* ── Right ── */}
        <div className="rvl-header-right">
          {rightSlot}
          <button
            className="rvl-theme-btn"
            onClick={toggle}
            title={`Switch to ${theme === "light" ? "dark" : "light"} mode`}
          >
            {theme === "light"
              ? <Moon size={14} color="var(--text-muted)" variant="Bulk" />
              : <Sun1 size={14} color="var(--text-muted)" variant="Bulk" />
            }
          </button>
        </div>

      </header>
    </>
  );
}