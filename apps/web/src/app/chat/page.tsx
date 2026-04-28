"use client";

import { useState, useRef, useEffect } from "react";
import { Flash, SidebarLeft, Cpu } from "iconsax-reactjs";
import AppHeader from "@/components/AppHeader";
import ChatSidebar from "@/components/chat/ChatSidebar";
import MessageItem from "@/components/chat/MessageItem";
import ChatInput from "@/components/chat/ChatInput";
import { useChat } from "@/hooks/useChat";

const SUGGESTED = [
  "What alerts fired today on this machine?",
  "List the latest tag values",
  "What does low nip pressure usually mean?"
];

const CHAT_MODEL_LABEL = process.env.NEXT_PUBLIC_OLLAMA_MODEL_LABEL ?? "llama3.2:1b";

export default function ChatPage() {
  const {
    conversations, active, activeId, setActiveId, loading,
    startNewChat, deleteConversation, updateMachineId, sendMessage
  } = useChat();

  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [isMobile, setIsMobile] = useState(false);
  const [search, setSearch] = useState("");
  const [input, setInput] = useState("");
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const mq = window.matchMedia("(max-width: 768px)");
    const apply = () => {
      const m = mq.matches;
      setIsMobile(m);
      if (m) setSidebarOpen(false);
    };
    apply();
    mq.addEventListener("change", apply);
    return () => mq.removeEventListener("change", apply);
  }, []);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
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
      <style>{`
        @keyframes rvl-bounce { 0%,80%,100%{transform:translateY(0);opacity:.35}40%{transform:translateY(-5px);opacity:1} }
        @keyframes rvl-fadein { from{opacity:0;transform:translateY(12px)}to{opacity:1;transform:translateY(0)} }
        @keyframes rvl-blink  { 0%,100%{opacity:1}50%{opacity:0} }
        @keyframes rvl-slide-in { from{opacity:0;transform:translateX(-10px)}to{opacity:1;transform:translateX(0)} }

        .rvl-msg { animation: rvl-fadein .3s cubic-bezier(.22,1,.36,1) both }
        .rvl-conv-item { transition: background .2s, border-color .2s; }
        .rvl-conv-item:hover .rvl-del { opacity:1!important; transform: scale(1); }
        .rvl-conv-item:hover { background:var(--surface-2)!important }
        .rvl-conv-item.active { background:var(--surface-3)!important; border-left:2px solid var(--accent)!important }
        .rvl-chip { transition: all .2s cubic-bezier(.4,0,.2,1); }
        .rvl-chip:hover { background:var(--surface-3)!important; border-color:var(--accent)!important; transform: translateY(-1px); color: var(--text)!important; }
        .rvl-input-focused { border-color: var(--accent)!important; box-shadow: 0 0 0 3px color-mix(in srgb, var(--accent) 12%, transparent)!important }
        .rvl-sidebar { transition: width .28s cubic-bezier(.4,0,.2,1), opacity .2s, transform .28s cubic-bezier(.4,0,.2,1); }
        /* Mobile Adjustments */
        @media (max-width: 768px) {
          .rvl-msg-bubble { max-width: 90%!important; }
          .rvl-chat-container { padding: 0 12px!important; }
          .rvl-header-machine-input { width: 90px!important; }
          .rvl-header-machine-label { display: none; }
          .rvl-empty-state { gap: 16px!important; padding: 0 16px!important; }
          .rvl-empty-icon { width: 52px!important; height: 52px!important; }
          .rvl-empty-icon svg { width: 24px!important; height: 24px!important; }
          .rvl-empty-title { fontSize: 19px!important; }
          .rvl-input-area { padding: 12px 12px 16px!important; }
        }
      `}</style>

      <div className="rvl-chat-layout" style={{ 
        display: "flex", 
        height: "100dvh", 
        maxHeight: "100dvh",
        background: "var(--bg)", 
        overflow: "hidden", 
        paddingBottom: "env(safe-area-inset-bottom, 0)",
        position: "relative"
      }}>
        {isMobile && sidebarOpen ? (
          <button
            type="button"
            aria-label="Close conversation list"
            onClick={() => setSidebarOpen(false)}
            style={{
              position: "fixed",
              inset: 0,
              zIndex: 45,
              border: "none",
              margin: 0,
              padding: 0,
              background: "rgba(15,14,12,0.42)",
              cursor: "pointer"
            }}
          />
        ) : null}
        <ChatSidebar
          open={sidebarOpen}
          onClose={() => setSidebarOpen(false)}
          onNewChat={() => {
            startNewChat();
            if (isMobile) setSidebarOpen(false);
          }}
          search={search}
          onSearchChange={setSearch}
          conversations={conversations}
          activeId={activeId}
          onSelect={(id) => {
            setActiveId(id);
            if (isMobile) setSidebarOpen(false);
          }}
          onDelete={deleteConversation}
          layout={isMobile ? "overlay" : "docked"}
        />

        <div style={{ 
          flex: 1, 
          display: "flex", 
          flexDirection: "column", 
          minWidth: 0,
          height: "100%",
          position: "relative",
          overflow: "hidden" 
        }}>
          <AppHeader
            backHref="/"
            backLabel="Dashboard"
            title={active?.title ?? "RAG Assistant"}
            subtitle={
              active
                ? `${active.machineId} · ${CHAT_MODEL_LABEL} · RAG`
                : `RVL Lamination · ${CHAT_MODEL_LABEL} · RAG`
            }
            icon={<Flash size={14} color="var(--accent)" variant="Bulk" />}
            rightSlot={
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                {!sidebarOpen && (
                  <button onClick={() => setSidebarOpen(true)} title="Open sidebar" style={{ background: "var(--surface-2)", border: "1px solid var(--border)", borderRadius: 7, padding: 6, cursor: "pointer", display: "flex", color: "var(--text-muted)" }}>
                    <SidebarLeft size={14} color="currentColor" />
                  </button>
                )}
                <span className="rvl-header-machine-label" style={{ fontSize: 11, color: "var(--text-muted)" }}>Machine</span>
                <input
                  className="rvl-header-machine-input"
                  value={active?.machineId ?? "machine_1"}
                  onChange={e => updateMachineId(e.target.value)}
                  style={{ width: 120, background: "var(--surface-2)", border: "1px solid var(--border)", borderRadius: 6, padding: "4px 9px", fontSize: 12, color: "var(--text)", outline: "none", fontFamily: "monospace", transition: "width .2s" }}
                />
                <button
                  type="button"
                  title="Ask about open and recent alerts"
                  onClick={() => handleSend("Show open alerts and any alerts closed in the last 24 hours for this machine.")}
                  style={{
                    fontSize: 11,
                    fontWeight: 600,
                    background: "var(--surface-2)",
                    border: "1px solid var(--border)",
                    borderRadius: 6,
                    padding: "4px 10px",
                    color: "var(--accent)",
                    cursor: "pointer",
                    fontFamily: "inherit",
                  }}
                >
                  Alerts
                </button>
              </div>
            }
          />

          <div style={{ flex: 1, overflowY: "auto", padding: isEmpty ? 0 : "24px 0 8px" }}>
            {isEmpty ? (
              <div className="rvl-empty-state" style={{ display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", height: "100%", gap: 40, padding: "0 24px", textAlign: "center", animation: "rvl-fadein .6s ease-out" }}>
                <div style={{ position: "relative", animation: "rvl-fadein-up .6s ease both" }}>
                  <div className="rvl-empty-icon" style={{ 
                    width: 64, height: 64, borderRadius: 20, 
                    background: "var(--accent-faint)", border: "1px solid color-mix(in srgb, var(--accent) 30%, transparent)",
                    display: "flex", alignItems: "center", justifyContent: "center",
                    boxShadow: "0 10px 30px -10px color-mix(in srgb, var(--accent) 30%, transparent)"
                  }}>
                    <Cpu size={32} color="var(--accent)" variant="Bulk" />
                  </div>
                  <div style={{ position: "absolute", bottom: -4, right: -4, width: 22, height: 22, borderRadius: "50%", background: "var(--bg)", border: "2px solid var(--bg)", display: "flex", alignItems: "center", justifyContent: "center", boxShadow: "0 2px 8px rgba(0,0,0,0.1)" }}>
                    <div style={{ width: 10, height: 10, borderRadius: "50%", background: "#22c55e", animation: "rvl-blink 2s infinite" }} />
                  </div>
                </div>
                
                <div style={{ maxWidth: 500, animation: "rvl-fadein-up .6s ease both", animationDelay: "0.1s" }}>
                  <h1 style={{ fontSize: 28, fontWeight: 800, color: "var(--text)", marginBottom: 12, letterSpacing: "-0.02em" }}>RVL Lamination AI</h1>
                  <p style={{ fontSize: 16, color: "var(--text-muted)", lineHeight: 1.6, margin: 0 }}>
                    Intelligent assistance for machine operations, data analysis, and process optimization.
                  </p>
                </div>

                <div style={{ 
                  display: "grid", 
                  gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))", 
                  gap: 16, 
                  width: "100%", 
                  maxWidth: 800,
                  animation: "rvl-fadein-up .6s ease both",
                  animationDelay: "0.2s"
                }}>
                  {SUGGESTED.map((s, idx) => (
                    <button 
                      key={s} 
                      onClick={() => handleSend(s)} 
                      style={{ 
                        textAlign: "left",
                        padding: "20px 24px",
                        background: "var(--surface-2)",
                        border: "1px solid var(--border)",
                        borderRadius: 16,
                        color: "var(--text)",
                        cursor: "pointer",
                        transition: "all .2s cubic-bezier(.4,0,.2,1)",
                        display: "flex",
                        flexDirection: "column",
                        gap: 8,
                        boxShadow: "0 2px 8px rgba(0,0,0,0.02)",
                        fontFamily: "inherit"
                      }}
                      onMouseEnter={(e) => {
                        (e.currentTarget as HTMLElement).style.borderColor = "var(--accent)";
                        (e.currentTarget as HTMLElement).style.background = "var(--bg)";
                        (e.currentTarget as HTMLElement).style.transform = "translateY(-2px)";
                        (e.currentTarget as HTMLElement).style.boxShadow = "0 10px 20px -10px rgba(0,0,0,0.05)";
                      }}
                      onMouseLeave={(e) => {
                        (e.currentTarget as HTMLElement).style.borderColor = "var(--border)";
                        (e.currentTarget as HTMLElement).style.background = "var(--surface-2)";
                        (e.currentTarget as HTMLElement).style.transform = "translateY(0)";
                        (e.currentTarget as HTMLElement).style.boxShadow = "0 2px 8px rgba(0,0,0,0.02)";
                      }}
                    >
                      <div style={{ fontSize: 14, fontWeight: 600 }}>{s}</div>
                      <div style={{ fontSize: 12, color: "var(--text-faint)", fontWeight: 400 }}>Ask to get real-time insights</div>
                    </button>
                  ))}
                </div>
              </div>
            ) : (
              <div className="rvl-chat-container" style={{ maxWidth: 720, margin: "0 auto", padding: "0 20px", display: "flex", flexDirection: "column", gap: 8 }}>
                {msgs.map((msg, i) => (
                  <MessageItem key={i} msg={msg} isLast={i === msgs.length - 1} />
                ))}
                {loading && (
                  <div className="rvl-msg" style={{ display: "flex", alignItems: "flex-start", gap: 12, padding: "4px 0" }}>
                    <div style={{ flexShrink: 0, marginTop: 3, width: 26, height: 26, borderRadius: 7, background: "var(--accent-faint)", border: "1px solid var(--border)", display: "flex", alignItems: "center", justifyContent: "center" }}>
                      <Cpu size={13} color="var(--accent)" variant="Bulk" />
                    </div>
                    <ThinkingIndicator />
                  </div>
                )}
                <div ref={bottomRef} style={{ height: 4 }} />
              </div>
            )}
          </div>

          <ChatInput
            input={input}
            onInputChange={setInput}
            onSend={handleSend}
            loading={loading}
            placeholder={active ? "Ask about tags, alerts, or operational data…" : "Start a new conversation…"}
          />
        </div>
      </div>
    </>
  );
}

const THINKING_STEPS = [
  { label: "Searching documents" },
  { label: "Querying databases" },
  { label: "Generating response" },
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
    <div style={{ paddingTop: 8, paddingLeft: 4, display: "flex", flexDirection: "column", gap: 2 }}>
      {THINKING_STEPS.slice(0, step + 1).map((s, i) => (
        <div
          key={i}
          style={{
            display: "flex", alignItems: "center", gap: 12, fontSize: 12.5,
            color: i === step ? "var(--text-muted)" : "var(--text-faint)",
            animation: "rvl-fadein .3s ease both",
            padding: "4px 0",
          }}
        >
          {/* Step indicator dot */}
          <div style={{
            width: 7, height: 7, borderRadius: "50%", flexShrink: 0,
            background: i < step ? "#22c55e" : i === step ? "var(--accent)" : "var(--border)",
            transition: "all .4s cubic-bezier(.4,0,.2,1)",
            boxShadow: i === step ? "0 0 0 4px color-mix(in srgb, var(--accent) 15%, transparent)" : "none",
            transform: i === step ? "scale(1)" : "scale(0.85)"
          }} />
          <span style={{ fontWeight: i === step ? 500 : 400 }}>{s.label}</span>
          {i === step && <TypingDots />}
        </div>
      ))}
    </div>
  );
}

function TypingDots() {
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 3, height: 16, marginLeft: 2 }}>
      {[0, 1, 2].map(n => <span key={n} style={{ display: "inline-block", width: 3, height: 3, borderRadius: "50%", background: "var(--text-faint)", animation: "rvl-bounce 1.3s ease-in-out infinite", animationDelay: `${n * 0.18}s` }} />)}
    </span>
  );
}
