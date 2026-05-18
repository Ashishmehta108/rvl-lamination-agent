"use client";

import { useState, useRef, useEffect } from "react";
import { Flash, SidebarLeft, Cpu } from "iconsax-reactjs";
import ChatSidebar from "@/components/chat/ChatSidebar";
import MessageItem from "@/components/chat/MessageItem";
import ChatInput from "@/components/chat/ChatInput";
import { useChat } from "@/hooks/useChat";


const SUGGESTED = [
  "What alerts fired today on this machine?",
  "Show me the trend for MASTER_SPEED_PCT last 2 days",
  "What is the current line efficiency?",
  "List all live tag values",
];

export default function ChatPage() {
  const {
    conversations, active, activeId, setActiveId, loading,
    startNewChat, deleteConversation, updateMachineId, sendMessage,
  } = useChat();

  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [isMobile, setIsMobile] = useState(false);
  const [search, setSearch] = useState("");
  const [input, setInput] = useState("");

  const bottomRef = useRef<HTMLDivElement>(null);
  const scrollAreaRef = useRef<HTMLDivElement>(null);

  // Responsive detection
  useEffect(() => {
    const mq = window.matchMedia("(max-width: 768px)");
    const apply = () => {
      const m = mq.matches;
      setIsMobile(m);
      setSidebarOpen(!m);
    };
    apply();
    mq.addEventListener("change", apply);
    return () => mq.removeEventListener("change", apply);
  }, []);

  // Auto-scroll
  useEffect(() => {
    const el = scrollAreaRef.current;
    if (!el) return;
    el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
  }, [active?.messages, loading]);

  const handleSend = (text?: any) => {
    const rawText = typeof text === "string" ? text : input;
    const t = (rawText ?? "").trim();
    if (!t) return;
    sendMessage(t);
    setInput("");
  };

  const msgs = active?.messages ?? [];
  const isEmpty = msgs.length === 0;

  return (
    <>
      {/* ── Styles ── */}
      <style jsx global>{`
        @keyframes rvl-bounce     { 0%,80%,100%{transform:translateY(0);opacity:.3}40%{transform:translateY(-4px);opacity:1} }
        @keyframes rvl-fadein     { from{opacity:0;transform:translateY(7px)}to{opacity:1;transform:translateY(0)} }
        @keyframes rvl-chip-in    { from{opacity:0;transform:translateY(5px) scale(.97)}to{opacity:1;transform:translateY(0) scale(1)} }
        @keyframes rvl-pulse-ring { 0%{box-shadow:0 0 0 0 rgba(158,90,50,.35)}70%{box-shadow:0 0 0 10px rgba(158,90,50,0)}100%{box-shadow:0 0 0 0 rgba(158,90,50,0)} }
        @keyframes rvl-shimmer-bg { from{background-position:200% 0}to{background-position:-200% 0} }
        @keyframes rvl-text-shimmer {
          0%   { background-position: 100% 50%; }
          100% { background-position: -100% 50%; }
        }
        @keyframes rvl-dot-pulse {
          0%, 100% { transform: scale(0.55); opacity: 0.25; }
          50%       { transform: scale(1);    opacity: 1; }
        }
        .rvl-shimmer-text {
          background: linear-gradient(90deg,var(--text-faint) 0%,var(--text) 35%,var(--text-faint) 65%,var(--text-faint) 100%);
          background-size: 200% 100%;
          -webkit-background-clip: text;
          background-clip: text;
          -webkit-text-fill-color: transparent;
          animation: rvl-text-shimmer 1.5s linear infinite;
        }
        .rvl-noscroll::-webkit-scrollbar { display:none; }
        .rvl-noscroll { -ms-overflow-style:none; scrollbar-width:none; }
        .rvl-msg-chip {
          border: 1px solid var(--border);
          background: var(--surface);
          color: var(--text-muted);
          transition: background .14s, border-color .14s, color .14s, transform .12s;
        }
        .rvl-msg-chip:hover {
          background: var(--surface-2) !important;
          border-color: var(--accent) !important;
          color: var(--text) !important;
          transform: translateY(-1px);
        }

        /* ── Prevent unwanted text-size inflation on mobile ── */
        html { -webkit-text-size-adjust: 100%; }
      `}</style>

      {/*
        Root shell: fills parent (AppShell owns 100dvh).
        Desktop: sidebar + main side-by-side.
        Mobile: sidebar overlay + main column (top-bar → scroll → input footer).
      */}
      <div
        style={{
          display: "flex",
          flex: 1,
          minHeight: 0,
          width: "100%",
          overflow: "hidden",
          background: "var(--bg)",
          color: "var(--text)",
          position: "relative",
        }}
      >
        {/* ── SIDEBAR ── */}
        {isMobile ? (
          <>
            <div
              style={{
                position: "fixed", inset: "0 auto 0 0", zIndex: 50,
                width: "min(288px, 88vw)",
                transform: sidebarOpen ? "translateX(0)" : "translateX(-100%)",
                transition: "transform .24s cubic-bezier(.4,0,.2,1)",
                boxShadow: sidebarOpen ? "12px 0 40px rgba(0,0,0,0.18)" : "none",
              }}
            >
              <ChatSidebar
                open={sidebarOpen}
                onClose={() => setSidebarOpen(false)}
                onNewChat={() => { startNewChat(); setSidebarOpen(false); }}
                search={search}
                onSearchChange={setSearch}
                conversations={conversations}
                activeId={activeId}
                onSelect={(id) => { setActiveId(id); setSidebarOpen(false); }}
                onDelete={deleteConversation}
                layout="overlay"
              />
            </div>
            {sidebarOpen && (
              <div
                onClick={() => setSidebarOpen(false)}
                style={{
                  position: "fixed", inset: 0, zIndex: 49,
                  background: "rgba(0,0,0,0.4)",
                  backdropFilter: "blur(2px)",
                }}
              />
            )}
          </>
        ) : (
          /* Desktop: docked */
          <div
            style={{
              flexShrink: 0,
              width: sidebarOpen ? 260 : 44,
              transition: "width .22s cubic-bezier(.4,0,.2,1)",
              overflow: "hidden",
              borderRight: "1px solid var(--border)",
              background: "var(--surface)",
              display: "flex",
              flexDirection: "column",
              position: "relative",
              zIndex: 10,
            }}
          >
            {sidebarOpen ? (
              <ChatSidebar
                open={sidebarOpen}
                onClose={() => setSidebarOpen(false)}
                onNewChat={startNewChat}
                search={search}
                onSearchChange={setSearch}
                conversations={conversations}
                activeId={activeId}
                onSelect={setActiveId}
                onDelete={deleteConversation}
                layout="docked"
              />
            ) : (
              <CollapsedDock onOpen={() => setSidebarOpen(true)} onNewChat={startNewChat} />
            )}
          </div>
        )}

        {/* ── MAIN CHAT COLUMN ── */}
        <main
          style={{
            flex: 1,
            display: "flex",
            flexDirection: "column",
            overflow: "hidden",
            minWidth: 0,
            background: "var(--bg)",
            position: "relative",
          }}
        >
          {/* Mobile top bar */}
          {isMobile && (
            <div style={{
              flexShrink: 0,
              display: "flex",
              alignItems: "center",
              gap: 8,
              padding: "10px 16px",
              borderBottom: "1px solid var(--border)",
              background: "var(--surface)",
            }}>
              <button
                onClick={() => setSidebarOpen(true)}
                title="Open sidebar"
                style={{
                  background: "none", border: "none",
                  borderRadius: 8, padding: 8, cursor: "pointer",
                  color: "var(--text-faint)", display: "flex", alignItems: "center",
                  transition: "background .15s, color .15s",
                }}
                onMouseEnter={e => {
                  (e.currentTarget as HTMLButtonElement).style.background = "var(--surface-2)";
                  (e.currentTarget as HTMLButtonElement).style.color = "var(--text)";
                }}
                onMouseLeave={e => {
                  (e.currentTarget as HTMLButtonElement).style.background = "none";
                  (e.currentTarget as HTMLButtonElement).style.color = "var(--text-faint)";
                }}
              >
                <SidebarLeft size={16} color="currentColor" />
              </button>
              <span style={{
                flex: 1, fontSize: 13, fontWeight: 600,
                color: "var(--text)",
                textAlign: "left",         /* explicit: no centring on mobile */
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
              }}>
                {active?.title ?? "Assistant"}
              </span>
            </div>
          )}

          {/* Scrollable messages — flex: 1 so it fills remaining space */}
          <div
            ref={scrollAreaRef}
            className="rvl-noscroll"
            style={{
              flex: 1,
              minHeight: 0,
              overflowY: "auto",
              overflowX: "hidden",
              overscrollBehavior: "contain",
            }}
          >
            {isEmpty ? (
              <EmptyState onSend={handleSend} />
            ) : (
              <div style={{
                maxWidth: 720, margin: "0 auto",
                /*
                  Desktop: 28px top, 32px bottom (input bar is a footer, not absolute).
                  Mobile:  same — the input footer sits outside this scroll area so
                           we only need a small bottom gap.
                */
                padding: isMobile ? "20px 16px 24px" : "28px 20px 32px",
                display: "flex", flexDirection: "column", gap: 4,
              }}>
                {msgs.map((msg, i) => (
                  <MessageItem key={i} msg={msg} isLast={i === msgs.length - 1} />
                ))}
                {loading && (
                  <div style={{
                    display: "flex", alignItems: "flex-start", gap: 14,
                    padding: "12px 0",
                    animation: "rvl-fadein .18s cubic-bezier(.22,1,.36,1) both",
                  }}>
                    <AgentAvatar />
                    <ThinkingIndicator />
                  </div>
                )}
                <div ref={bottomRef} />
              </div>
            )}
          </div>

          {/*
            ── INPUT FOOTER ──
            Rendered as a normal flex child (flexShrink: 0) so it always sits at
            the bottom of the column without needing position:absolute or a magic
            bottom offset. Works on both desktop and mobile.
          */}
          <div style={{
            flexShrink: 0,



            /* Soft fade so messages don't hard-clip at the bar */

          }}>
            <div style={{ maxWidth: 720, margin: "0 auto" }}>
              <ChatInput
                input={input}
                onInputChange={setInput}
                onSend={handleSend}
                loading={loading}
                placeholder={active ? "Ask about tags, alerts, or trends…" : "Start a new conversation…"}
              />
            </div>
          </div>
        </main>
      </div>
    </>
  );
}

/* ── Collapsed sidebar dock (Notion-style) ── */
function CollapsedDock({ onOpen, onNewChat }: { onOpen: () => void; onNewChat: () => void }) {
  return (
    <div style={{
      display: "flex", flexDirection: "column", alignItems: "center",
      paddingTop: 12, gap: 4, width: 44,
    }}>
      <button
        onClick={onOpen}
        title="Open sidebar"
        style={{
          background: "none", border: "none", cursor: "pointer",
          padding: 10, borderRadius: 8, color: "var(--text-faint)",
          display: "flex", alignItems: "center", justifyContent: "center",
          transition: "background .15s, color .15s",
        }}
        onMouseEnter={e => {
          (e.currentTarget as HTMLButtonElement).style.background = "var(--surface-2)";
          (e.currentTarget as HTMLButtonElement).style.color = "var(--text)";
        }}
        onMouseLeave={e => {
          (e.currentTarget as HTMLButtonElement).style.background = "none";
          (e.currentTarget as HTMLButtonElement).style.color = "var(--text-faint)";
        }}
      >
        <SidebarLeft size={17} color="currentColor" />
      </button>
      <button
        onClick={onNewChat}
        title="New chat"
        style={{
          background: "none", border: "none", cursor: "pointer",
          padding: 10, borderRadius: 8, color: "var(--text-faint)",
          display: "flex", alignItems: "center", justifyContent: "center",
          transition: "background .15s, color .15s",
        }}
        onMouseEnter={e => {
          (e.currentTarget as HTMLButtonElement).style.background = "var(--surface-2)";
          (e.currentTarget as HTMLButtonElement).style.color = "var(--text)";
        }}
        onMouseLeave={e => {
          (e.currentTarget as HTMLButtonElement).style.background = "none";
          (e.currentTarget as HTMLButtonElement).style.color = "var(--text-faint)";
        }}
      >
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M12 5H6a2 2 0 0 0-2 2v11a2 2 0 0 0 2 2h11a2 2 0 0 0 2-2v-6" />
          <path d="M18.375 2.625a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4Z" />
        </svg>
      </button>
    </div>
  );
}

/* ── Agent avatar ── */
function AgentAvatar() {
  return (
    <div style={{
      flexShrink: 0, width: 32, height: 32, borderRadius: 10,
      background: "var(--accent-faint)", border: "1px solid rgba(158,90,50,.2)",
      display: "flex", alignItems: "center", justifyContent: "center",
      boxShadow: "0 1px 4px rgba(0,0,0,.06)",
    }}>
      <Cpu size={16} color="var(--accent)" variant="Bulk" />
    </div>
  );
}

/* ── Empty state ── */
function EmptyState({ onSend }: { onSend: (t: string) => void }) {
  return (
    <div style={{
      display: "flex", flexDirection: "column", alignItems: "center",
      justifyContent: "center", minHeight: "75dvh",
      gap: 28, padding: "0 24px 32px",
      /* text-align: center only for the hero block, chips stay centered via flex */
      animation: "rvl-fadein .32s cubic-bezier(.22,1,.36,1) both",
    }}>
      <div style={{ position: "relative" }}>
        <div style={{
          width: 60, height: 60, borderRadius: 18,
          background: "var(--accent-faint)",
          border: "1px solid color-mix(in srgb, var(--accent) 25%, transparent)",
          display: "flex", alignItems: "center", justifyContent: "center",
          boxShadow: "0 4px 24px color-mix(in srgb, var(--accent) 15%, transparent)",
        }}>
          <Flash size={28} color="var(--accent)" variant="Bulk" />
        </div>
        <div style={{
          position: "absolute", inset: 0, borderRadius: 18,
          animation: "rvl-pulse-ring 3.5s ease-in-out infinite",
          pointerEvents: "none",
        }} />
      </div>

      {/* Title/subtitle — centred text is intentional here (hero block) */}
      <div style={{ maxWidth: 380, textAlign: "center" }}>
        <h2 style={{
          fontSize: 21, fontWeight: 700, letterSpacing: "-0.025em",
          margin: "0 0 8px", color: "var(--text)",
          textAlign: "center",
        }}>
          RVL Lamination Assistant
        </h2>
        <p style={{
          fontSize: 13, color: "var(--text-muted)", lineHeight: 1.7, margin: 0,
          textAlign: "center",
        }}>
          Operational intelligence at your fingertips. Ask about machine performance,
          active alerts, or production trends.
        </p>
      </div>

      <div style={{ display: "flex", flexWrap: "wrap", gap: 7, justifyContent: "center", maxWidth: 500 }}>
        {SUGGESTED.map((s, idx) => (
          <button
            key={s}
            className="rvl-msg-chip"
            onClick={() => onSend(s)}
            style={{
              padding: "7px 15px", fontSize: 12, fontWeight: 500,
              borderRadius: 999, cursor: "pointer", fontFamily: "inherit",
              textAlign: "center",
              animation: `rvl-chip-in .32s cubic-bezier(.22,1,.36,1) ${idx * 0.06}s both`,
            }}
          >
            {s}
          </button>
        ))}
      </div>
    </div>
  );
}

/* ── Thinking indicator — Vercel-style ── */
const THINKING_STEPS = [
  "Analyzing operational context",
  "Fetching sensor telemetry",
  "Evaluating thresholds",
  "Finalizing response",
];

function ThinkingIndicator() {
  const [step, setStep] = useState(0);
  const [visible, setVisible] = useState(true);

  useEffect(() => {
    const t = setInterval(() => {
      setVisible(false);
      setTimeout(() => {
        setStep(s => (s < THINKING_STEPS.length - 1 ? s + 1 : s));
        setVisible(true);
      }, 220);
    }, 2200);
    return () => clearInterval(t);
  }, []);

  return (
    <div style={{
      display: "flex", alignItems: "center",
      animation: "rvl-fadein .18s cubic-bezier(.22,1,.36,1) both",
      paddingTop: 4,
    }}>
      <span
        className="rvl-shimmer-text"
        style={{
          fontSize: 12.5, fontWeight: 500,
          opacity: visible ? 1 : 0,
          transition: "opacity .22s ease",
          letterSpacing: "-0.01em",
        }}
      >
        {THINKING_STEPS[step]}
      </span>
    </div>
  );
}