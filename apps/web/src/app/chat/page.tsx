"use client";

import type { KeyboardEvent } from "react";
import { useCallback, useEffect, useRef, useState } from "react";
import { AddSquare, Cpu, ArrowUp, Flash, Trash, Copy, TickCircle, SearchNormal1, SidebarLeft } from "iconsax-reactjs";
import AppHeader from "../../components/AppHeader";

// ── Typewriter hook ──────────────────────────────────────────
function useTypewriter(target: string, active: boolean, speed = 8) {
  const [displayed, setDisplayed] = useState("");
  const idx = useRef(0);
  useEffect(() => {
    if (!active) { setDisplayed(target); return; }
    idx.current = 0;
    setDisplayed("");
    const iv = setInterval(() => {
      idx.current += speed;
      setDisplayed(target.slice(0, idx.current));
      if (idx.current >= target.length) clearInterval(iv);
    }, 16);
    return () => clearInterval(iv);
  }, [target, active, speed]);
  return active ? displayed : target;
}

// ── Helpers ──────────────────────────────────────────────────
function fmtTime(ts: number) {
  const d = new Date(ts);
  const diff = (Date.now() - ts) / 60000;
  if (diff < 1) return "just now";
  if (diff < 60) return `${Math.floor(diff)}m ago`;
  return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

const API = process.env.NEXT_PUBLIC_BACKEND_URL ?? "http://127.0.0.1:7000";
const TOKEN = process.env.NEXT_PUBLIC_API_AUTH_TOKEN ?? "dev-local-token";
const STORE_KEY = "rvl-conversations";

type Role = "user" | "assistant";
interface Message { role: Role; content: string; citations?: { index: number; chunkId: string; sourceUri: string | null }[]; error?: boolean; }
interface Conversation { id: string; title: string; machineId: string; messages: Message[]; createdAt: number; updatedAt: number; }

const SUGGESTED = ["What alerts fired today on this machine?", "List the latest tag values", "What does low nip pressure usually mean?"];

function uid() { return Math.random().toString(36).slice(2) + Date.now().toString(36); }

function groupByDate(convs: Conversation[]) {
  const now = Date.now();
  const today: Conversation[] = [], yesterday: Conversation[] = [], week: Conversation[] = [], older: Conversation[] = [];
  convs.forEach(c => {
    const diff = (now - c.updatedAt) / 86400000;
    if (diff < 1) today.push(c);
    else if (diff < 2) yesterday.push(c);
    else if (diff < 7) week.push(c);
    else older.push(c);
  });
  return [{ label: "Today", items: today }, { label: "Yesterday", items: yesterday }, { label: "Last 7 days", items: week }, { label: "Older", items: older }].filter(g => g.items.length > 0);
}

function TypingDots() {
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 4, height: 20 }}>
      {[0, 1, 2].map(n => <span key={n} style={{ display: "inline-block", width: 5, height: 5, borderRadius: "50%", background: "var(--text-faint)", animation: "rvl-bounce 1.3s ease-in-out infinite", animationDelay: `${n * 0.18}s` }} />)}
    </span>
  );
}

function CopyBtn({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  const copy = () => { navigator.clipboard.writeText(text); setCopied(true); setTimeout(() => setCopied(false), 1800); };
  return (
    <button onClick={copy} title="Copy" style={{ background: "none", border: "none", cursor: "pointer", padding: 4, borderRadius: 5, color: "var(--text-faint)", display: "flex", alignItems: "center", transition: "color .15s" }}
      onMouseEnter={e => (e.currentTarget.style.color = "var(--text-muted)")}
      onMouseLeave={e => (e.currentTarget.style.color = "var(--text-faint)")}>
      {copied ? <TickCircle size={14} color="var(--accent)" variant="Bulk" /> : <Copy size={14} color="currentColor" />}
    </button>
  );
}

// ── Streaming AI message ─────────────────────────────────────
function AiMessage({ msg, isLast }: { msg: Message; isLast: boolean }) {
  const text = useTypewriter(msg.content, isLast && !msg.error, 12);
  return (
    <div style={{ flex: 1, minWidth: 0, paddingTop: 3 }}>
      <div style={{ fontSize: 14, lineHeight: 1.75, color: msg.error ? "#c45" : "var(--text)", whiteSpace: "pre-wrap", wordBreak: "break-word" }}>
        {text}
        {isLast && text.length < msg.content.length && (
          <span style={{ display: "inline-block", width: 2, height: 14, background: "var(--accent)", marginLeft: 2, verticalAlign: "middle", animation: "rvl-blink 1s step-end infinite" }} />
        )}
      </div>
      {msg.citations && msg.citations.length > 0 && (
        <div style={{ display: "flex", flexWrap: "wrap", gap: 5, marginTop: 10 }}>
          {msg.citations.map(c => (
            <span key={c.index} title={c.sourceUri ?? c.chunkId} style={{ fontSize: 10.5, background: "var(--surface-2)", border: "1px solid var(--border)", borderRadius: 4, padding: "2px 8px", color: "var(--accent)", maxWidth: 260, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
              [{c.index}] {c.sourceUri ?? c.chunkId}
            </span>
          ))}
        </div>
      )}
      <div style={{ marginTop: 6 }}><CopyBtn text={msg.content} /></div>
    </div>
  );
}

export default function ChatPage() {
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [inputFocused, setInputFocused] = useState(false);
  const [search, setSearch] = useState("");
  const bottomRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // Load from localStorage
  useEffect(() => {
    try {
      const raw = localStorage.getItem(STORE_KEY);
      if (raw) { const parsed: Conversation[] = JSON.parse(raw); setConversations(parsed); if (parsed.length) setActiveId(parsed[0].id); }
    } catch { /* ignore */ }
  }, []);

  // Save to localStorage
  useEffect(() => {
    if (conversations.length) localStorage.setItem(STORE_KEY, JSON.stringify(conversations));
  }, [conversations]);

  useEffect(() => { bottomRef.current?.scrollIntoView({ behavior: "smooth" }); }, [conversations, activeId, loading]);

  useEffect(() => {
    const el = textareaRef.current; if (!el) return;
    el.style.height = "auto"; el.style.height = `${Math.min(el.scrollHeight, 160)}px`;
  }, [input]);

  const active = conversations.find(c => c.id === activeId) ?? null;

  const newChat = useCallback(() => {
    const c: Conversation = { id: uid(), title: "New conversation", machineId: "machine_1", messages: [], createdAt: Date.now(), updatedAt: Date.now() };
    setConversations(prev => [c, ...prev]);
    setActiveId(c.id);
    setInput("");
  }, []);

  const deleteConv = (id: string) => {
    setConversations(prev => prev.filter(c => c.id !== id));
    setActiveId(prev => prev === id ? (conversations.find(c => c.id !== id)?.id ?? null) : prev);
  };

  const setMachineId = (val: string) => {
    if (!activeId) return;
    setConversations(prev => prev.map(c => c.id === activeId ? { ...c, machineId: val } : c));
  };

  async function send(text?: string) {
    const finalText = (text ?? input).trim();
    if (!finalText || loading) return;

    let convId = activeId;
    // Create new conversation if none active
    if (!convId) {
      const c: Conversation = { id: uid(), title: finalText.slice(0, 42), machineId: "machine_1", messages: [], createdAt: Date.now(), updatedAt: Date.now() };
      setConversations(prev => [c, ...prev]);
      convId = c.id;
      setActiveId(c.id);
    }

    const userMsg: Message = { role: "user", content: finalText };
    setConversations(prev => prev.map(c => {
      if (c.id !== convId) return c;
      const msgs = [...c.messages, userMsg];
      return { ...c, messages: msgs, title: c.messages.length === 0 ? finalText.slice(0, 42) : c.title, updatedAt: Date.now() };
    }));
    setInput("");
    setLoading(true);

    try {
      const conv = conversations.find(c => c.id === convId);
      const history = [...(conv?.messages ?? []), userMsg];
      const res = await fetch(`${API}/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${TOKEN}` },
        body: JSON.stringify({ machineId: conv?.machineId || undefined, messages: history.filter(m => !m.error).map(m => ({ role: m.role, content: m.content })) }),
      });
      if (!res.ok) { const err = await res.json().catch(() => ({})); throw new Error((err as any).error ?? `HTTP ${res.status}`); }
      const data = (await res.json()) as { answer: string; citations: { index: number; chunkId: string; sourceUri: string | null }[] };
      setConversations(prev => prev.map(c => c.id === convId ? { ...c, messages: [...c.messages, { role: "assistant", content: data.answer, citations: data.citations }], updatedAt: Date.now() } : c));
    } catch (e: any) {
      setConversations(prev => prev.map(c => c.id === convId ? { ...c, messages: [...c.messages, { role: "assistant", content: `⚠ ${e.message}`, error: true }], updatedAt: Date.now() } : c));
    } finally { setLoading(false); }
  }

  function handleKey(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); }
  }

  const filteredGroups = groupByDate(conversations.filter(c => c.title.toLowerCase().includes(search.toLowerCase())));
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
        #chat-input::placeholder { color:var(--text-faint) }
        .rvl-input-focused { border-color: var(--accent)!important; box-shadow: 0 0 0 3px color-mix(in srgb, var(--accent) 12%, transparent)!important }
        .rvl-sidebar { transition: width .22s cubic-bezier(.4,0,.2,1), opacity .2s }
      `}</style>

      <div style={{ display: "flex", height: "100vh", background: "var(--bg)", overflow: "hidden" }}>

        {/* ── Sidebar ──────────────────────────────────────── */}
        <aside className="rvl-sidebar" style={{
          width: sidebarOpen ? 252 : 0,
          flexShrink: 0,
          overflow: "hidden",
          display: "flex",
          flexDirection: "column",
          background: "var(--surface)",
          borderRight: sidebarOpen ? "1px solid var(--border)" : "none",
          opacity: sidebarOpen ? 1 : 0,
        }}>
          {/* Sidebar header */}
          <div style={{ padding: "14px 12px 10px", display: "flex", alignItems: "center", gap: 8, borderBottom: "1px solid var(--border)", flexShrink: 0 }}>
            <button onClick={newChat} id="new-chat-btn" style={{
              flex: 1, display: "flex", alignItems: "center", gap: 7, background: "var(--accent)", border: "none", borderRadius: 7,
              padding: "7px 10px", color: "#fff", fontSize: 12.5, fontWeight: 600, cursor: "pointer", fontFamily: "inherit", whiteSpace: "nowrap",
            }}>
              <AddSquare size={14} color="#fff" /> New chat
            </button>
            <button onClick={() => setSidebarOpen(false)} title="Close sidebar" style={{ background: "none", border: "none", cursor: "pointer", color: "var(--text-faint)", display: "flex", padding: 5, borderRadius: 6, flexShrink: 0 }}>
              <SidebarLeft size={16} color="currentColor" />
            </button>
          </div>

          {/* Search */}
          <div style={{ padding: "10px 10px 6px", flexShrink: 0 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 7, background: "var(--surface-2)", border: "1px solid var(--border)", borderRadius: 7, padding: "5px 10px" }}>
              <SearchNormal1 size={12} color="var(--text-faint)" />
              <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Search…"
                style={{ flex: 1, background: "none", border: "none", outline: "none", fontSize: 12, color: "var(--text)", fontFamily: "inherit", minWidth: 0 }} />
            </div>
          </div>

          {/* Conversation list */}
          <div style={{ flex: 1, overflowY: "auto", padding: "4px 6px" }}>
            {conversations.length === 0 && (
              <div style={{ padding: "28px 12px", fontSize: 12, color: "var(--text-faint)", textAlign: "center", lineHeight: 1.6 }}>
                No conversations yet.<br />Hit <strong>New chat</strong> to begin.
              </div>
            )}
            {filteredGroups.map(group => (
              <div key={group.label}>
                <div style={{ fontSize: 10, fontWeight: 700, letterSpacing: "0.07em", textTransform: "uppercase", color: "var(--text-faint)", padding: "10px 8px 4px", whiteSpace: "nowrap" }}>{group.label}</div>
                {group.items.map(conv => {
                  const lastMsg = conv.messages[conv.messages.length - 1];
                  const preview = lastMsg ? lastMsg.content.slice(0, 55) + (lastMsg.content.length > 55 ? "…" : "") : "No messages yet";
                  return (
                    <div key={conv.id} className={`rvl-conv-item${conv.id === activeId ? " active" : ""}`}
                      onClick={() => setActiveId(conv.id)}
                      style={{ display: "flex", alignItems: "center", gap: 6, padding: "8px 8px 8px 10px", borderRadius: 7, cursor: "pointer", background: "transparent", marginBottom: 1, borderLeft: "2px solid transparent" }}>
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: 4 }}>
                          <div style={{ fontSize: 12.5, fontWeight: conv.id === activeId ? 600 : 400, color: "var(--text)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", flex: 1 }}>{conv.title}</div>
                          <div style={{ fontSize: 9.5, color: "var(--text-faint)", whiteSpace: "nowrap", flexShrink: 0 }}>{fmtTime(conv.updatedAt)}</div>
                        </div>
                        <div style={{ fontSize: 11, color: "var(--text-faint)", marginTop: 2, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{preview}</div>
                      </div>
                      <button className="rvl-del" onClick={e => { e.stopPropagation(); deleteConv(conv.id); }}
                        style={{ flexShrink: 0, background: "none", border: "none", cursor: "pointer", padding: 3, borderRadius: 4, color: "var(--text-faint)", opacity: 0, transition: "opacity .15s" }}>
                        <Trash size={12} color="currentColor" />
                      </button>
                    </div>
                  );
                })}
              </div>
            ))}
          </div>
        </aside>

        {/* ── Main area ─────────────────────────────────────── */}
        <div style={{ flex: 1, display: "flex", flexDirection: "column", minWidth: 0 }}>

          <AppHeader
            title={active?.title ?? "RAG Assistant"}
            subtitle={active ? `${active.machineId} · phi4-mini · Ollama` : "RVL Lamination · Ollama + RAG"}
            icon={<Flash size={14} color="var(--accent)" variant="Bulk" />}
            rightSlot={
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                {!sidebarOpen && (
                  <button onClick={() => setSidebarOpen(true)} title="Open sidebar"
                    style={{ background: "none", border: "1px solid var(--border)", borderRadius: 7, padding: 6, cursor: "pointer", display: "flex", color: "var(--text-muted)" }}>
                    <SidebarLeft size={14} color="currentColor" />
                  </button>
                )}
                <span style={{ fontSize: 11, color: "var(--text-muted)" }}>Machine</span>
                <input id="chat-machine-id" value={active?.machineId ?? "machine_1"} onChange={e => setMachineId(e.target.value)}
                  style={{ width: 120, background: "var(--surface-2)", border: "1px solid var(--border)", borderRadius: 6, padding: "4px 9px", fontSize: 12, color: "var(--text)", outline: "none", fontFamily: "ui-monospace,'Cascadia Code',Menlo,monospace" }} />
                {active && active.messages.length > 0 && (
                  <button onClick={() => setConversations(prev => prev.map(c => c.id === activeId ? { ...c, messages: [], updatedAt: Date.now() } : c))}
                    title="Clear conversation"
                    style={{ background: "none", border: "1px solid var(--border)", borderRadius: 7, padding: "4px 9px", cursor: "pointer", fontSize: 11, color: "var(--text-muted)", fontFamily: "inherit" }}>
                    Clear
                  </button>
                )}
              </div>
            }
          />

          {/* Messages */}
          <div style={{ flex: 1, overflowY: "auto", padding: isEmpty ? 0 : "24px 0 8px" }}>

            {/* Empty state */}
            {isEmpty && (
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
                    <button key={s} className="rvl-chip" onClick={() => send(s)}
                      style={{ fontSize: 12, background: "var(--surface)", border: "1px solid var(--border)", borderRadius: 20, padding: "6px 14px", color: "var(--text-muted)", cursor: "pointer", transition: "background .15s", fontFamily: "inherit" }}>
                      {s}
                    </button>
                  ))}
                </div>
              </div>
            )}

            {!isEmpty && (
              <div style={{ maxWidth: 720, margin: "0 auto", padding: "0 20px", display: "flex", flexDirection: "column", gap: 6 }}>
                {msgs.map((msg, i) => (
                  msg.role === "user" ? (
                    <div key={i} className="rvl-msg" style={{ display: "flex", justifyContent: "flex-end", gap: 6, padding: "4px 0", alignItems: "flex-end" }}>
                      <CopyBtn text={msg.content} />
                      <div style={{ maxWidth: "78%", background: "var(--surface-2)", border: "1px solid var(--border)", borderRadius: "18px 18px 4px 18px", padding: "10px 16px", fontSize: 14, lineHeight: 1.7, color: "var(--text)", whiteSpace: "pre-wrap", wordBreak: "break-word" }}>
                        {msg.content}
                      </div>
                    </div>
                  ) : (
                    <div key={i} className="rvl-msg" style={{ display: "flex", alignItems: "flex-start", gap: 12, padding: "4px 0" }}>
                      <div style={{ flexShrink: 0, marginTop: 3, width: 26, height: 26, borderRadius: 7, background: "var(--accent-faint)", border: "1px solid var(--border)", display: "flex", alignItems: "center", justifyContent: "center" }}>
                        <Cpu size={13} color="var(--accent)" variant="Bulk" />
                      </div>
                      <AiMessage msg={msg} isLast={i === msgs.length - 1} />
                    </div>
                  )
                ))}

                {loading && (
                  <div className="rvl-msg" style={{ display: "flex", alignItems: "flex-start", gap: 12, padding: "4px 0" }}>
                    <div style={{ flexShrink: 0, marginTop: 3, width: 26, height: 26, borderRadius: 7, background: "var(--accent-faint)", border: "1px solid var(--border)", display: "flex", alignItems: "center", justifyContent: "center" }}>
                      <Cpu size={13} color="var(--accent)" variant="Bulk" />
                    </div>
                    <div style={{ paddingTop: 10 }}><TypingDots /></div>
                  </div>
                )}
                <div ref={bottomRef} style={{ height: 4 }} />
              </div>
            )}
          </div>

          {/* Input bar */}
          <div style={{ borderTop: "1px solid var(--border)", background: "var(--surface)", padding: "12px 20px 16px", flexShrink: 0 }}>
            <div style={{ maxWidth: 720, margin: "0 auto" }}>
              <div className={inputFocused ? "rvl-input-focused" : ""} style={{ display: "flex", alignItems: "flex-end", gap: 8, background: "var(--surface-2)", border: "1px solid var(--border)", borderRadius: 12, padding: "8px 8px 8px 14px", boxShadow: "var(--shadow)", transition: "border-color .15s, box-shadow .15s" }}>
                <textarea ref={textareaRef} id="chat-input" rows={1}
                  placeholder={active ? "Ask about tags, alerts, or operational data…" : "Start a new conversation…"}
                  value={input} onChange={e => setInput(e.target.value)} onKeyDown={handleKey} disabled={loading}
                  onFocus={() => setInputFocused(true)}
                  onBlur={() => setInputFocused(false)}
                  style={{ flex: 1, background: "transparent", border: "none", outline: "none", resize: "none", color: "var(--text)", fontSize: 14, lineHeight: 1.55, fontFamily: "inherit", overflowY: "auto", paddingTop: 0 }}
                />
                <button id="chat-send-btn" onClick={() => send()} disabled={loading || !input.trim()}
                  style={{ flexShrink: 0, width: 30, height: 30, borderRadius: "50%", border: "none", background: loading || !input.trim() ? "var(--surface-3)" : "var(--accent)", display: "flex", alignItems: "center", justifyContent: "center", cursor: loading || !input.trim() ? "not-allowed" : "pointer", transition: "background .15s" }}
                  onMouseEnter={e => { if (!loading && input.trim()) (e.currentTarget as HTMLElement).style.background = "var(--accent-hover)"; }}
                  onMouseLeave={e => { if (!loading && input.trim()) (e.currentTarget as HTMLElement).style.background = "var(--accent)"; }}>
                  <ArrowUp size={14} color="#fff" variant="Bold" />
                </button>
              </div>
              <div style={{ textAlign: "center", fontSize: 10.5, color: "var(--text-faint)", marginTop: 8 }}>
                ⏎ Send &nbsp;·&nbsp; ⇧⏎ New line &nbsp;·&nbsp; Powered by Ollama + RAG
              </div>
            </div>
          </div>
        </div>
      </div>
    </>
  );
}
