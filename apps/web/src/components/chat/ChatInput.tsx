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
    <div style={{ borderTop: "1px solid var(--border)", background: "var(--surface)", padding: "14px 24px 18px", flexShrink: 0 }}>
      <div style={{ maxWidth: 740, margin: "0 auto" }}>
        <div className={focused ? "rvl-input-focused" : ""} style={{
          display: "flex", alignItems: "flex-end", gap: 12, background: "var(--surface-2)", border: "1.5px solid var(--border)", 
          borderRadius: 24, padding: "10px 12px 10px 20px", boxShadow: focused ? undefined : "var(--shadow)", transition: "all .2s ease"
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
            style={{ flex: 1, background: "transparent", border: "none", outline: "none", resize: "none", color: "var(--text)", fontSize: 15, lineHeight: 1.5, fontFamily: "inherit", overflowY: "auto", padding: "4px 0", maxHeight: 160 }}
          />
          <button onClick={onSend} disabled={loading || !input.trim()} style={{
            flexShrink: 0, width: 38, height: 38, borderRadius: "50%", border: "none", 
            background: loading || !input.trim() ? "var(--surface-3)" : "var(--accent)", 
            display: "flex", alignItems: "center", justifyContent: "center", cursor: loading || !input.trim() ? "not-allowed" : "pointer", transition: "all 0.2s ease",
            boxShadow: loading || !input.trim() ? "none" : "0 2px 8px color-mix(in srgb, var(--accent) 25%, transparent)"
          }}>
            <ArrowUp size={18} color={loading || !input.trim() ? "var(--text-faint)" : "#fff"} variant="Bold" />
          </button>
        </div>
        <div style={{ textAlign: "center", fontSize: 11, color: "var(--text-faint)", marginTop: 10, letterSpacing: "0.01em" }}>
          ⏎ Send &nbsp;·&nbsp; ⇧⏎ New line &nbsp;·&nbsp; Powered by Ollama + RAG
        </div>
      </div>
    </div>
  );
}
