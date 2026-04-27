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
      <style>{`
        @keyframes rvl-bounce { 0%,80%,100%{transform:translateY(0);opacity:.35}40%{transform:translateY(-5px);opacity:1} }
        @keyframes rvl-fadein { from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:translateY(0)} }
        @keyframes rvl-blink  { 0%,100%{opacity:1}50%{opacity:0} }
        .rvl-msg { animation: rvl-fadein .24s cubic-bezier(.22,1,.36,1) both }
        .rvl-conv-item:hover .rvl-del { opacity:1!important }
        .rvl-conv-item:hover { background:var(--surface-2)!important }
        .rvl-conv-item.active { background:var(--surface-3)!important; border-left:2px solid var(--accent)!important }
        .rvl-chip:hover { background:var(--surface-3)!important; border-color:var(--text-faint)!important }
        .rvl-input-focused { border-color: var(--accent)!important; box-shadow: 0 0 0 3px color-mix(in srgb, var(--accent) 12%, transparent)!important }
        .rvl-sidebar { transition: width .22s cubic-bezier(.4,0,.2,1), opacity .2s }
      `}</style>

      <div className="rvl-chat-layout" style={{ display: "flex", height: "100dvh", background: "var(--bg)", overflow: "hidden", paddingBottom: "env(safe-area-inset-bottom, 0)" }}>
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

        <div style={{ flex: 1, display: "flex", flexDirection: "column", minWidth: 0 }}>
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
                  <button onClick={() => setSidebarOpen(true)} title="Open sidebar" style={{ background: "none", border: "1px solid var(--border)", borderRadius: 7, padding: 6, cursor: "pointer", display: "flex", color: "var(--text-muted)" }}>
                    <SidebarLeft size={14} color="currentColor" />
                  </button>
                )}
                <span style={{ fontSize: 11, color: "var(--text-muted)" }}>Machine</span>
                <input
                  value={active?.machineId ?? "machine_1"}
                  onChange={e => updateMachineId(e.target.value)}
                  style={{ width: 120, background: "var(--surface-2)", border: "1px solid var(--border)", borderRadius: 6, padding: "4px 9px", fontSize: 12, color: "var(--text)", outline: "none", fontFamily: "monospace" }}
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
              <div style={{ display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", height: "100%", gap: 20, padding: "0 20px", textAlign: "center" }}>
                <div style={{ width: 52, height: 52, borderRadius: 14, background: "var(--accent-faint)", border: "1px solid var(--border)", display: "flex", alignItems: "center", justifyContent: "center" }}>
                  <Flash size={24} color="var(--accent)" variant="Bulk" />
                </div>
                <div>
                  <div style={{ fontSize: 17, fontWeight: 600, color: "var(--text)", marginBottom: 6 }}>RVL Lamination Assistant</div>
                  <div style={{ fontSize: 13, color: "var(--text-muted)", maxWidth: 360, lineHeight: 1.6 }}>
                    Ask anything about your machine's tags, alerts, or operational data.
                  </div>
                </div>
                <div style={{ display: "flex", flexWrap: "wrap", gap: 8, justifyContent: "center", maxWidth: 540 }}>
                  {SUGGESTED.map(s => (
                    <button key={s} className="rvl-chip" onClick={() => handleSend(s)} style={{ fontSize: 12, background: "var(--surface)", border: "1px solid var(--border)", borderRadius: 20, padding: "6px 14px", color: "var(--text-muted)", cursor: "pointer", transition: "background .15s", fontFamily: "inherit" }}>
                      {s}
                    </button>
                  ))}
                </div>
              </div>
            ) : (
              <div style={{ maxWidth: 720, margin: "0 auto", padding: "0 20px", display: "flex", flexDirection: "column", gap: 6 }}>
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
    <div style={{ paddingTop: 6, paddingLeft: 2, display: "flex", flexDirection: "column", gap: 0 }}>
      {THINKING_STEPS.slice(0, step + 1).map((s, i) => (
        <div
          key={i}
          style={{
            display: "flex", alignItems: "center", gap: 10, fontSize: 12,
            color: i === step ? "var(--text-muted)" : "var(--text-faint)",
            animation: "rvl-fadein .25s ease both",
            padding: "3px 0",
          }}
        >
          {/* Step indicator dot */}
          <div style={{
            width: 6, height: 6, borderRadius: "50%", flexShrink: 0,
            background: i < step ? "#22c55e" : i === step ? "var(--accent)" : "var(--border)",
            transition: "background .3s",
            boxShadow: i === step ? "0 0 0 3px color-mix(in srgb, var(--accent) 20%, transparent)" : "none"
          }} />
          <span>{s.label}</span>
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
