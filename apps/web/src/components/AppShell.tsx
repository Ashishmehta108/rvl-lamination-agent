"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Home, Chart, DocumentText, MessageText } from "iconsax-reactjs";
import { useAppContext } from "@/context/AppContext";

const NAV_LINKS = [
  { href: "/",           label: "Dashboard",  icon: (a: boolean) => <Home        size={20} variant={a ? "Bulk" : "Linear"} color="currentColor" /> },
  { href: "/production", label: "Production", icon: (a: boolean) => <Chart       size={20} variant={a ? "Bulk" : "Linear"} color="currentColor" /> },
  { href: "/reports",    label: "Reports",    icon: (a: boolean) => <DocumentText size={20} variant={a ? "Bulk" : "Linear"} color="currentColor" /> },
  { href: "/chat",       label: "Assistant",  icon: (a: boolean) => <MessageText  size={20} variant={a ? "Bulk" : "Linear"} color="currentColor" /> },
];

export default function AppShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname() ?? "";
  const { menuOpen, setMenuOpen } = useAppContext();

  const isActive = (href: string) =>
    href === "/" ? pathname === "/" : pathname === href || pathname.startsWith(href);

  return (
    <>
      <style>{`
        /* ── AppShell layout ── */
        .rvl-shell {
          display: flex;
          flex-direction: column;
          height: 100dvh;
          overflow: hidden;
        }

        /* ── Desktop top navbar ── */
        .rvl-topnav {
          display: none;   /* hidden on mobile */
          align-items: center;
          justify-content: space-between;
          padding: 0 24px;
          height: 52px;
          flex-shrink: 0;
          border-bottom: 1px solid var(--border-subtle);
          background: var(--surface);
          position: sticky;
          top: 0;
          z-index: 30;
          box-shadow: var(--shadow);
        }
        @media (min-width: 768px) {
          .rvl-topnav { display: flex; }
        }

        .rvl-topnav-logo {
          font-size: 11px;
          font-weight: 700;
          letter-spacing: 0.08em;
          color: var(--text-faint);
          flex-shrink: 0;
        }

        .rvl-topnav-links {
          display: flex;
          align-items: center;
          gap: 2px;
        }

        .rvl-topnav-link {
          font-size: 12px;
          font-weight: 500;
          color: var(--text-muted);
          text-decoration: none;
          padding: 6px 12px;
          border-radius: 7px;
          background: transparent;
          border: 1px solid transparent;
          transition: color .15s, background .15s, border-color .15s;
          white-space: nowrap;
        }
        .rvl-topnav-link:hover {
          background: var(--surface-2);
          color: var(--text);
        }
        .rvl-topnav-link.active {
          font-weight: 600;
          color: var(--text);
          background: var(--surface-2);
          border-color: var(--border);
        }

        /* ── Page content ── */
        .rvl-content {
          flex: 1;
          display: flex;
          flex-direction: column;
          min-height: 0;
          overflow-y: auto;
          /* leave room for mobile bottom nav */
          padding-bottom: 60px;
        }
        @media (min-width: 768px) {
          .rvl-content { padding-bottom: 0; }
        }

        /* ── Mobile bottom navigation ── */
        .rvl-bottomnav {
          display: flex;   /* shown on mobile */
          position: fixed;
          bottom: 0; left: 0; right: 0;
          z-index: 60;
          height: 60px;
          background: var(--surface);
          border-top: 1px solid var(--border);
          padding-bottom: env(safe-area-inset-bottom, 0px);
        }
        @media (min-width: 768px) {
          .rvl-bottomnav { display: none; }
        }

        .rvl-bottomnav-link {
          flex: 1;
          display: flex;
          flex-direction: column;
          align-items: center;
          justify-content: center;
          gap: 3px;
          text-decoration: none;
          color: var(--text-faint);
          font-size: 10px;
          font-weight: 400;
          transition: color .15s;
          -webkit-tap-highlight-color: transparent;
        }
        .rvl-bottomnav-link.active {
          color: var(--accent);
          font-weight: 600;
        }
      `}</style>

      <div className="rvl-shell">

        {/* ── Desktop top navbar ── */}
        <nav aria-label="Primary" className="rvl-topnav">
          <span className="rvl-topnav-logo">RVL</span>

          <div className="rvl-topnav-links">
            {NAV_LINKS.map(({ href, label }) => {
              const active = isActive(href);
              return (
                <Link
                  key={href}
                  href={href}
                  prefetch
                  className={`rvl-topnav-link${active ? " active" : ""}`}
                >
                  {label}
                </Link>
              );
            })}
          </div>
        </nav>

        {/* ── Page content ── */}
        <div className="rvl-content">
          {children}
        </div>

        {/* ── Mobile bottom navigation ── */}
        <nav aria-label="Mobile navigation" className="rvl-bottomnav">
          {NAV_LINKS.map(({ href, label, icon }) => {
            const active = isActive(href);
            return (
              <Link
                key={href}
                href={href}
                prefetch
                className={`rvl-bottomnav-link${active ? " active" : ""}`}
              >
                {icon(active)}
                {label}
              </Link>
            );
          })}
        </nav>

      </div>
    </>
  );
}