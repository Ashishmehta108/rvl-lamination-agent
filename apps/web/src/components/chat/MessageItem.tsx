import React, { useState } from "react";
import { Cpu, DocumentText, SearchNormal1, TickCircle } from "iconsax-reactjs";
import { Message, ToolStep } from "../../hooks/useChat";
import { useTypewriter } from "../../hooks/useTypewriter";
import CopyBtn from "./CopyBtn";

interface MessageItemProps {
  msg: Message;
  isLast: boolean;
}

/* ── Inline SVG icons for tools (avoids iconsax missing exports) ── */
const DbIcon = () => (
  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <ellipse cx="12" cy="5" rx="9" ry="3" />
    <path d="M21 12c0 1.66-4 3-9 3s-9-1.34-9-3" />
    <path d="M3 5v14c0 1.66 4 3 9 3s9-1.34 9-3V5" />
  </svg>
);

const ChevronIcon = ({ up }: { up: boolean }) => (
  <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"
    style={{ transition: "transform .2s", transform: up ? "rotate(180deg)" : "rotate(0)" }}>
    <polyline points="6 9 12 15 18 9" />
  </svg>
);

const ClockIcon = () => (
  <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <circle cx="12" cy="12" r="10" />
    <polyline points="12 6 12 12 16 14" />
  </svg>
);

/* ── Tool icon mapping ── */
function ToolIcon({ tool }: { tool: string }) {
  if (tool === "rag_search") return <SearchNormal1 size={11} color="currentColor" variant="Bold" />;
  if (tool === "alerts_db" || tool === "tags_db") return <DbIcon />;
  if (tool === "reports_db") return <DocumentText size={11} color="currentColor" variant="Bold" />;
  if (tool === "llm") return <Cpu size={11} color="currentColor" variant="Bold" />;
  return <DbIcon />;
}

/* ── Steps accordion ── */
function StepsPanel({ steps }: { steps: ToolStep[] }) {
  const [open, setOpen] = useState(false);
  const totalMs = steps.reduce((s, t) => s + t.durationMs, 0);

  return (
    <div style={{ marginBottom: 6 }}>
      <button
        onClick={() => setOpen(!open)}
        style={{
          display: "inline-flex", alignItems: "center", gap: 5,
          fontSize: 11, color: "var(--text-muted)", background: "var(--surface-2)",
          border: "1px solid var(--border)", borderRadius: 6, padding: "3px 10px 3px 8px",
          cursor: "pointer", fontFamily: "inherit", transition: "all .15s",
          lineHeight: 1.5
        }}
      >
        <ClockIcon />
        <span>{steps.length} steps · {(totalMs / 1000).toFixed(1)}s</span>
        <ChevronIcon up={open} />
      </button>

      {open && (
        <div style={{
          marginTop: 6, borderLeft: "2px solid var(--border)",
          marginLeft: 8, paddingLeft: 12, display: "flex", flexDirection: "column", gap: 4
        }}>
          {steps.map((step, i) => (
            <div key={i} style={{
              display: "flex", alignItems: "center", gap: 8, fontSize: 11.5,
              color: "var(--text-muted)", animation: "rvl-fadein .2s ease both",
              animationDelay: `${i * 0.06}s`
            }}>
              <div style={{
                width: 18, height: 18, borderRadius: 4, flexShrink: 0,
                background: step.tool === "llm" ? "var(--accent-faint)" : "var(--surface-2)",
                border: "1px solid var(--border)",
                display: "flex", alignItems: "center", justifyContent: "center",
                color: step.tool === "llm" ? "var(--accent)" : "var(--text-muted)"
              }}>
                <ToolIcon tool={step.tool} />
              </div>
              <span style={{ flex: 1 }}>{step.label}</span>
              <span style={{ fontSize: 10, color: "var(--text-faint)", fontFamily: "monospace" }}>
                {step.durationMs < 1000 ? `${step.durationMs}ms` : `${(step.durationMs / 1000).toFixed(1)}s`}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export default function MessageItem({ msg, isLast }: MessageItemProps) {
  const isAssistant = msg.role === "assistant";
  const text = useTypewriter(msg.content, isAssistant && isLast && !msg.error, 12);

  if (!isAssistant) {
    return (
      <div className="rvl-msg" style={{ display: "flex", justifyContent: "flex-end", gap: 6, padding: "4px 0", alignItems: "flex-end" }}>
        <CopyBtn text={msg.content} />
        <div style={{ maxWidth: "78%", background: "var(--surface-2)", border: "1px solid var(--border)", borderRadius: "18px 18px 4px 18px", padding: "10px 16px", fontSize: 14, lineHeight: 1.7, color: "var(--text)", whiteSpace: "pre-wrap", wordBreak: "break-word" }}>
          {msg.content}
        </div>
      </div>
    );
  }

  return (
    <div className="rvl-msg" style={{ display: "flex", alignItems: "flex-start", gap: 12, padding: "4px 0" }}>
      <div style={{ flexShrink: 0, marginTop: 3, width: 26, height: 26, borderRadius: 7, background: "var(--accent-faint)", border: "1px solid var(--border)", display: "flex", alignItems: "center", justifyContent: "center" }}>
        <Cpu size={13} color="var(--accent)" variant="Bulk" />
      </div>
      <div style={{ flex: 1, minWidth: 0, paddingTop: 3 }}>
        {/* Tool steps accordion */}
        {msg.steps && msg.steps.length > 0 && <StepsPanel steps={msg.steps} />}

        {/* Answer text */}
        <div style={{ fontSize: 14, lineHeight: 1.75, color: msg.error ? "#c45" : "var(--text)", whiteSpace: "pre-wrap", wordBreak: "break-word" }}>
          {text}
          {isLast && text.length < msg.content.length && (
            <span style={{ display: "inline-block", width: 2, height: 14, background: "var(--accent)", marginLeft: 2, verticalAlign: "middle", animation: "rvl-blink 1s step-end infinite" }} />
          )}
        </div>

        {/* Grounding + Citations footer */}
        {!msg.error && (msg.grounded !== undefined || (msg.citations && msg.citations.length > 0)) && (
          <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 6, marginTop: 8 }}>
            {msg.grounded !== undefined && (
              <span
                title={msg.grounded ? "Response backed by retrieved data" : "No matching data found"}
                style={{
                  display: "inline-flex", alignItems: "center", gap: 4,
                  fontSize: 10.5, borderRadius: 4, padding: "2px 8px",
                  background: msg.grounded ? "color-mix(in srgb, #22c55e 10%, transparent)" : "color-mix(in srgb, #f59e0b 10%, transparent)",
                  border: `1px solid ${msg.grounded ? "color-mix(in srgb, #22c55e 25%, transparent)" : "color-mix(in srgb, #f59e0b 25%, transparent)"}`,
                  color: msg.grounded ? "#22c55e" : "#f59e0b",
                  fontWeight: 500
                }}
              >
                {msg.grounded ? <><TickCircle size={10} color="#22c55e" variant="Bold" /> Grounded</> : "Ungrounded"}
              </span>
            )}

            {msg.citations && msg.citations.length > 0 && msg.citations.map((c, i) => (
              <span key={i} title={c.sourceUri ?? c.chunkId} style={{ fontSize: 10.5, background: "var(--surface-2)", border: "1px solid var(--border)", borderRadius: 4, padding: "2px 8px", color: "var(--accent)", maxWidth: 220, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                [{c.index}] {c.sourceUri ?? c.chunkId}
              </span>
            ))}
          </div>
        )}

        <div style={{ marginTop: 6 }}><CopyBtn text={msg.content} /></div>
      </div>
    </div>
  );
}
