import React from "react";
import { Cpu } from "iconsax-reactjs";
import { Message } from "../../hooks/useChat";
import { useTypewriter } from "../../hooks/useTypewriter";
import CopyBtn from "./CopyBtn";

interface MessageItemProps {
  msg: Message;
  isLast: boolean;
}

export default function MessageItem({ msg, isLast }: MessageItemProps) {
  const isAssistant = msg.role === "assistant";
  const text = useTypewriter(msg.content, isAssistant && isLast && !msg.error, 12);

  if (!isAssistant) {
    return (
      <div className="rvl-msg" style={{ display: "flex", justifyContent: "flex-end", gap: 8, padding: "6px 0", alignItems: "flex-end" }}>
        <div className="rvl-msg-actions"><CopyBtn text={msg.content} /></div>
        <div className="rvl-user-bubble" style={{ maxWidth: "78%", background: "var(--surface-2)", border: "1px solid var(--border)", borderRadius: "20px 20px 4px 20px", padding: "12px 18px", fontSize: 14, lineHeight: 1.7, color: "var(--text)", whiteSpace: "pre-wrap", wordBreak: "break-word" }}>
          {msg.content}
        </div>
      </div>
    );
  }

  return (
    <div className="rvl-msg" style={{ display: "flex", alignItems: "flex-start", gap: 14, padding: "8px 0" }}>
      <div className="rvl-assistant-avatar" style={{ flexShrink: 0, marginTop: 3, width: 30, height: 30, borderRadius: 9, background: "linear-gradient(135deg, var(--accent-faint), color-mix(in srgb, var(--accent) 15%, var(--surface)))", border: "1px solid var(--border)", display: "flex", alignItems: "center", justifyContent: "center" }}>
        <Cpu size={14} color="var(--accent)" variant="Bulk" />
      </div>
      <div style={{ flex: 1, minWidth: 0, paddingTop: 3 }}>
        <div style={{ fontSize: 14, lineHeight: 1.8, color: msg.error ? "#c45" : "var(--text)", whiteSpace: "pre-wrap", wordBreak: "break-word" }}>
          {text}
          {isLast && text.length < msg.content.length && (
            <span style={{ display: "inline-block", width: 2, height: 16, background: "var(--accent)", marginLeft: 2, verticalAlign: "middle", animation: "rvl-blink 1s step-end infinite", borderRadius: 1 }} />
          )}
        </div>
        {msg.citations && msg.citations.length > 0 && (
          <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginTop: 12 }}>
            {msg.citations.map((c, i) => (
              <span key={i} className="rvl-citation" title={c.sourceUri ?? c.chunkId} style={{ fontSize: 10.5, background: "var(--surface-2)", border: "1px solid var(--border)", borderRadius: 6, padding: "3px 10px", color: "var(--accent)", fontWeight: 500, maxWidth: 280, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                [{c.index}] {c.sourceUri ?? c.chunkId}
              </span>
            ))}
          </div>
        )}
        <div className="rvl-msg-actions" style={{ marginTop: 6 }}><CopyBtn text={msg.content} /></div>
      </div>
    </div>
  );
}
