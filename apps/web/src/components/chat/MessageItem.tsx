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
        <div style={{ fontSize: 14, lineHeight: 1.75, color: msg.error ? "#c45" : "var(--text)", whiteSpace: "pre-wrap", wordBreak: "break-word" }}>
          {text}
          {isLast && text.length < msg.content.length && (
            <span style={{ display: "inline-block", width: 2, height: 14, background: "var(--accent)", marginLeft: 2, verticalAlign: "middle", animation: "rvl-blink 1s step-end infinite" }} />
          )}
        </div>
        {msg.citations && msg.citations.length > 0 && (
          <div style={{ display: "flex", flexWrap: "wrap", gap: 5, marginTop: 10 }}>
            {msg.citations.map((c, i) => (
              <span key={i} title={c.sourceUri ?? c.chunkId} style={{ fontSize: 10.5, background: "var(--surface-2)", border: "1px solid var(--border)", borderRadius: 4, padding: "2px 8px", color: "var(--accent)", maxWidth: 260, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
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
