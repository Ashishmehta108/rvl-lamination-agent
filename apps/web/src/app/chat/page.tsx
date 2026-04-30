"use client";

import { useState, useRef, useEffect } from "react";
import { Flash, SidebarLeft, Cpu } from "iconsax-reactjs";
import ChatSidebar from "@/components/chat/ChatSidebar";
import MessageItem from "@/components/chat/MessageItem";
import ChatInput from "@/components/chat/ChatInput";
import { useChat } from "@/hooks/useChat";
import { api } from "@/lib/api";
import { usePathname } from "next/navigation";

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

  const handleSend = (text?: string) => {
    const t = (text ?? input).trim();
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
        @keyframes rvl-bounce       { 0%,80%,100%{transform:translateY(0);opacity:.35}40%{transform:translateY(-5px);opacity:1} }
        @keyframes rvl-fadein       { from{opacity:0;transform:translateY(10px)}to{opacity:1;transform:translateY(0)} }
        @keyframes rvl-pulse-ring   { 0%{box-shadow:0 0 0 0 rgba(158,90,50,.4)}70%{box-shadow:0 0 0 10px rgba(158,90,50,0)}100%{box-shadow:0 0 0 0 rgba(158,90,50,0)} }
        @keyframes rvl-shimmer-bg   { from{background-position:200% 0}to{background-position:-200% 0} }

        /* TEXT shimmer — like Vercel */
        @keyframes rvl-text-shimmer {
          0%   { background-position: 100% 50%; }
          100% { background-position: -100% 50%; }
        }
        .rvl-shimmer-text {
          background: linear-gradient(
            90deg,
            var(--text-faint) 0%,
            var(--text) 30%,
            var(--text-faint) 60%,
            var(--text-faint) 100%
          );
          background-size: 200% 100%;
          -webkit-background-clip: text;
          background-clip: text;
          -webkit-text-fill-color: transparent;
          animation: rvl-text-shimmer 1.6s linear infinite;
        }

        .rvl-noscroll::-webkit-scrollbar { display:none; }
        .rvl-noscroll { -ms-overflow-style:none; scrollbar-width:none; }
      `}</style>

      {/*
        Root shell: full viewport, no overflow escaping.
        Desktop: sidebar + main side-by-side.
        Mobile: just main (sidebar overlays, bottom nav below).
      */}
      <div
        style={{
          display: "flex",
          height: "100dvh",
          width: "100%",
          overflow: "hidden",
          background: "var(--bg)",
          color: "var(--text)",
          position: "relative",
        }}
      >
        {/* ── SIDEBAR ── */}
        {isMobile ? (
          /* Mobile: full overlay */
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
          /* Desktop: docked — collapsed shows a thin icon-strip (Notion-style) */
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
              /* Collapsed dock strip */
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
                style={{
                  background: "none", border: "1px solid var(--border)",
                  borderRadius: 8, padding: 7, cursor: "pointer",
                  color: "var(--text-faint)", display: "flex", alignItems: "center",
                }}
              >
                <SidebarLeft size={16} color="currentColor" />
              </button>
              <span style={{ flex: 1, fontSize: 13, fontWeight: 600, color: "var(--text)" }}>
                {active?.title ?? "Assistant"}
              </span>
            </div>
          )}

          {/* Scrollable messages */}
          <div
            ref={scrollAreaRef}
            className="rvl-noscroll"
            style={{
              flex: 1,
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
                padding: "32px 16px 160px",
                display: "flex", flexDirection: "column", gap: 8,
              }}>
                {msgs.map((msg, i) => (
                  <MessageItem key={i} msg={msg} isLast={i === msgs.length - 1} />
                ))}
                {loading && (
                  <div style={{
                    display: "flex", alignItems: "flex-start", gap: 16,
                    padding: "16px 0",
                    animation: "rvl-fadein .3s ease both",
                  }}>
                    <AgentAvatar />
                    <ThinkingIndicator />
                  </div>
                )}
                <div ref={bottomRef} />
              </div>
            )}
          </div>

          {/* Sticky input */}
          <div style={{
            position: "absolute", bottom: isMobile ? 64 : 0,
            left: 0, right: 0,
            padding: "16px 16px 20px",
            background: "linear-gradient(to top, var(--bg) 60%, transparent)",
            zIndex: 20,
            pointerEvents: "none",
          }}>
            <div style={{ maxWidth: 720, margin: "0 auto", pointerEvents: "auto" }}>
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
        {/* Pencil icon substitute */}
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
      justifyContent: "center", minHeight: "80dvh",
      gap: 32, padding: "0 24px", textAlign: "center",
      animation: "rvl-fadein .5s ease both",
    }}>
      <div style={{ position: "relative" }}>
        <div style={{
          width: 64, height: 64, borderRadius: 18,
          background: "var(--accent-faint)", border: "1px solid rgba(158,90,50,.2)",
          display: "flex", alignItems: "center", justifyContent: "center",
        }}>
          <Flash size={32} color="var(--accent)" variant="Bulk" />
        </div>
        <div style={{
          position: "absolute", inset: 0, borderRadius: 18,
          animation: "rvl-pulse-ring 3s infinite",
          pointerEvents: "none",
        }} />
      </div>
      <div style={{ maxWidth: 400 }}>
        <h2 style={{ fontSize: 22, fontWeight: 700, letterSpacing: "-0.02em", margin: "0 0 10px" }}>
          RVL Lamination Assistant
        </h2>
        <p style={{ fontSize: 13.5, color: "var(--text-muted)", lineHeight: 1.6, margin: 0 }}>
          Operational intelligence at your fingertips. Ask about machine performance,
          active alerts, or production trends.
        </p>
      </div>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 8, justifyContent: "center", maxWidth: 480 }}>
        {SUGGESTED.map(s => (
          <button
            key={s}
            onClick={() => onSend(s)}
            style={{
              padding: "8px 16px", fontSize: 12, fontWeight: 500,
              background: "var(--surface)", border: "1px solid var(--border)",
              borderRadius: 999, color: "var(--text-muted)",
              cursor: "pointer", fontFamily: "inherit",
              transition: "background .15s, border-color .15s, color .15s",
            }}
            onMouseEnter={e => {
              const b = e.currentTarget as HTMLButtonElement;
              b.style.background = "var(--surface-2)";
              b.style.color = "var(--text)";
            }}
            onMouseLeave={e => {
              const b = e.currentTarget as HTMLButtonElement;
              b.style.background = "var(--surface)";
              b.style.color = "var(--text-muted)";
            }}
          >
            {s}
          </button>
        ))}
      </div>
    </div>
  );
}

/* ── Thinking indicator with Vercel-style text shimmer ── */
const THINKING_STEPS = [
  "Analyzing operational context",
  "Fetching sensor telemetry",
  "Evaluating thresholds",
  "Finalizing response",
];

function ThinkingIndicator() {
  const [step, setStep] = useState(0);

  useEffect(() => {
    const t = setInterval(() => {
      setStep(s => (s < THINKING_STEPS.length - 1 ? s + 1 : s));
    }, 2000);
    return () => clearInterval(t);
  }, []);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6, flex: 1, maxWidth: 320 }}>
      {/* Skeleton bars */}
      <div style={{ display: "flex", flexDirection: "column", gap: 8, marginBottom: 12 }}>
        {[0.75, 0.5].map((w, i) => (
          <div key={i} style={{
            height: 10, width: `${w * 100}%`,
            background: "var(--surface-2)", borderRadius: 99, overflow: "hidden", position: "relative",
          }}>
            <div style={{
              position: "absolute", inset: 0,
              background: "linear-gradient(90deg,transparent,rgba(158,90,50,.08),transparent)",
              backgroundSize: "200% 100%",
              animation: `rvl-shimmer-bg ${1.8 + i * 0.4}s linear infinite`,
            }} />
          </div>
        ))}
      </div>

      {/* Step list with text shimmer on active step */}
      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        {THINKING_STEPS.slice(0, step + 1).map((label, i) => {
          const isCurrentStep = i === step;
          const isDone = i < step;
          return (
            <div
              key={i}
              style={{
                display: "flex", alignItems: "center", gap: 10,
                fontSize: 11.5, fontWeight: 500,
                opacity: isDone ? 0.5 : 1,
                transition: "opacity .4s",
              }}
            >
              {/* Dot */}
              <div style={{
                width: 6, height: 6, borderRadius: "50%", flexShrink: 0,
                background: isDone ? "var(--green, #22c55e)" : isCurrentStep ? "var(--accent)" : "var(--border)",
                transform: isCurrentStep ? "scale(1.3)" : "scale(1)",
                boxShadow: isCurrentStep ? "0 0 8px rgba(158,90,50,.4)" : "none",
                transition: "all .3s",
              }} />

              {/* Label — shimmer on active, plain on done */}
              <span
                className={isCurrentStep ? "rvl-shimmer-text" : ""}
                style={!isCurrentStep ? { color: isDone ? "var(--text-faint)" : "var(--text)" } : undefined}
              >
                {label}
              </span>

              {/* Bouncing dots on active */}
              {isCurrentStep && (
                <span style={{ display: "flex", gap: 2, marginLeft: 2 }}>
                  {[0, 1, 2].map(n => (
                    <span key={n} style={{
                      width: 3, height: 3, borderRadius: "50%",
                      background: "var(--text-faint)",
                      display: "inline-block",
                      animation: `rvl-bounce 1.2s ${n * 0.2}s infinite`,
                    }} />
                  ))}
                </span>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}