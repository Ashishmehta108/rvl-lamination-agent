"use client";

import { useState, useRef, useEffect } from "react";
import { Flash, SidebarLeft, Cpu } from "iconsax-reactjs";
import AppHeader from "../../components/AppHeader";
import ChatSidebar from "../../components/chat/ChatSidebar";
import MessageItem from "../../components/chat/MessageItem";
import ChatInput from "../../components/chat/ChatInput";
import { useChat } from "../../hooks/useChat";

const SUGGESTED = [
  "What alerts fired today on this machine?",
  "List the latest tag values",
  "What does low nip pressure usually mean?"
];

export default function ChatPage() {
  const { 
    conversations, active, activeId, setActiveId, loading, 
    startNewChat, deleteConversation, updateMachineId, sendMessage 
  } = useChat();

  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [search, setSearch] = useState("");
  const [input, setInput] = useState("");
  const bottomRef = useRef<HTMLDivElement>(null);

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
        .rvl-msg { animation: rvl-fadein .28s cubic-bezier(.22,1,.36,1) both }
        .rvl-sidebar { transition: width .22s cubic-bezier(.4,0,.2,1), opacity .2s }
      `}</style>

      <div style={{ display: "flex", height: "100vh", background: "var(--bg)", overflow: "hidden" }}>
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
        />

        <div style={{ flex: 1, display: "flex", flexDirection: "column", minWidth: 0, position: "relative" }}>
          {!sidebarOpen && (
            <button onClick={() => setSidebarOpen(true)} title="Open sidebar" style={{
              position: "absolute", top: 12, left: 12, zIndex: 50,
              background: "var(--surface)", border: "1px solid var(--border)", borderRadius: 8, padding: 7,
              cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center",
              color: "var(--text-muted)", boxShadow: "var(--shadow)", transition: "all .15s ease"
            }}>
              <SidebarLeft size={16} color="currentColor" />
            </button>
          )}
          <AppHeader
            title={active?.title ?? "RAG Assistant"}
            subtitle={active ? `${active.machineId} · phi4-mini · Ollama` : "RVL Lamination · Ollama + RAG"}
            icon={<Flash size={14} color="var(--accent)" variant="Bulk" />}
            rightSlot={
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <span style={{ fontSize: 11, color: "var(--text-muted)" }}>Machine</span>
                <input 
                  value={active?.machineId ?? "machine_1"} 
                  onChange={e => updateMachineId(e.target.value)} 
                  style={{ width: 120, background: "var(--surface-2)", border: "1px solid var(--border)", borderRadius: 6, padding: "4px 9px", fontSize: 12, color: "var(--text)", outline: "none", fontFamily: "monospace" }} 
                />
              </div>
            }
          />

          <div className="rvl-chat-scroll" style={{ flex: 1, overflowY: "auto", padding: isEmpty ? 0 : "28px 0 12px" }}>
            {isEmpty ? (
              <div style={{ display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", height: "100%", gap: 24, padding: "0 24px", textAlign: "center" }}>
                <div className="rvl-hero-icon" style={{ width: 64, height: 64, borderRadius: 18, background: "linear-gradient(135deg, var(--accent-faint), color-mix(in srgb, var(--accent) 15%, var(--surface)))", border: "1px solid var(--border)", display: "flex", alignItems: "center", justifyContent: "center" }}>
                  <Flash size={28} color="var(--accent)" variant="Bulk" />
                </div>
                <div>
                  <div style={{ fontSize: 20, fontWeight: 700, color: "var(--text)", marginBottom: 8, letterSpacing: "-0.02em" }}>RVL Lamination Assistant</div>
                  <div style={{ fontSize: 14, color: "var(--text-muted)", maxWidth: 400, lineHeight: 1.65, margin: "0 auto" }}>
                    Ask anything about your machine’s tags, alerts, or operational data.
                  </div>
                </div>
                <div style={{ display: "flex", flexWrap: "wrap", gap: 10, justifyContent: "center", maxWidth: 580, marginTop: 4 }}>
                  {SUGGESTED.map(s => (
                    <button key={s} className="rvl-chip" onClick={() => handleSend(s)} style={{ fontSize: 12.5, background: "var(--surface)", border: "1px solid var(--border)", borderRadius: 24, padding: "8px 18px", color: "var(--text-muted)", cursor: "pointer", transition: "all .2s ease", fontFamily: "inherit", fontWeight: 500 }}>
                      {s}
                    </button>
                  ))}
                </div>
              </div>
            ) : (
              <div style={{ maxWidth: 740, margin: "0 auto", padding: "0 24px", display: "flex", flexDirection: "column", gap: 8 }}>
                {msgs.map((msg, i) => (
                  <MessageItem key={i} msg={msg} isLast={i === msgs.length - 1} />
                ))}
                {loading && (
                   <div className="rvl-msg" style={{ display: "flex", alignItems: "flex-start", gap: 14, padding: "8px 0" }}>
                      <div className="rvl-assistant-avatar" style={{ flexShrink: 0, marginTop: 3, width: 30, height: 30, borderRadius: 9, background: "linear-gradient(135deg, var(--accent-faint), color-mix(in srgb, var(--accent) 15%, var(--surface)))", border: "1px solid var(--border)", display: "flex", alignItems: "center", justifyContent: "center" }}>
                        <Cpu size={14} color="var(--accent)" variant="Bulk" />
                      </div>
                      <div style={{ paddingTop: 10 }}><TypingDots /></div>
                    </div>
                )}
                <div ref={bottomRef} style={{ height: 8 }} />
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

function TypingDots() {
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 4, height: 20 }}>
      {[0, 1, 2].map(n => <span key={n} style={{ display: "inline-block", width: 5, height: 5, borderRadius: "50%", background: "var(--text-faint)", animation: "rvl-bounce 1.3s ease-in-out infinite", animationDelay: `${n * 0.18}s` }} />)}
    </span>
  );
}
