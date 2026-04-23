import React, { useRef, useEffect, useState, KeyboardEvent } from "react";
import { ArrowUp } from "iconsax-reactjs";

interface ChatInputProps {
  input: string;
  onInputChange: (val: string) => void;
  onSend: () => void;
  loading: boolean;
  placeholder?: string;
}

export default function ChatInput({ input, onInputChange, onSend, loading, placeholder }: ChatInputProps) {
  const [focused, setFocused] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 160)}px`;
  }, [input]);

  const handleKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      onSend();
    }
  };

  return (
    <div style={{ borderTop: "1px solid var(--border)", background: "var(--surface)", padding: "12px 20px 16px", flexShrink: 0 }}>
      <div style={{ maxWidth: 720, margin: "0 auto" }}>
        <div className={focused ? "rvl-input-focused" : ""} style={{
          display: "flex", alignItems: "flex-end", gap: 8, background: "var(--surface-2)", border: "1px solid var(--border)", 
          borderRadius: 12, padding: "8px 8px 8px 14px", boxShadow: "var(--shadow)", transition: "border-color .15s, box-shadow .15s"
        }}>
          <textarea
            ref={textareaRef}
            rows={1}
            placeholder={placeholder}
            value={input}
            onChange={e => onInputChange(e.target.value)}
            onKeyDown={handleKey}
            disabled={loading}
            onFocus={() => setFocused(true)}
            onBlur={() => setFocused(false)}
            style={{ flex: 1, background: "transparent", border: "none", outline: "none", resize: "none", color: "var(--text)", fontSize: 14, lineHeight: 1.55, fontFamily: "inherit", overflowY: "auto", paddingTop: 0 }}
          />
          <button onClick={onSend} disabled={loading || !input.trim()} style={{
            flexShrink: 0, width: 30, height: 30, borderRadius: "50%", border: "none", 
            background: loading || !input.trim() ? "var(--surface-3)" : "var(--accent)", 
            display: "flex", alignItems: "center", justifyContent: "center", cursor: loading || !input.trim() ? "not-allowed" : "pointer", transition: "background .15s"
          }}>
            <ArrowUp size={14} color="#fff" variant="Bold" />
          </button>
        </div>
        <div style={{ textAlign: "center", fontSize: 10.5, color: "var(--text-faint)", marginTop: 8 }}>
          ⏎ Send &nbsp;·&nbsp; ⇧⏎ New line &nbsp;·&nbsp; Powered by Ollama + RAG
        </div>
      </div>
    </div>
  );
}
