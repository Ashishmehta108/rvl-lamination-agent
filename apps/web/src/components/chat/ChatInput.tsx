import React, { useRef, useEffect, useState, KeyboardEvent } from "react";
import { ArrowUp, Stop } from "iconsax-reactjs";

interface ChatInputProps {
  input: string;
  onInputChange: (val: string) => void;
  onSend: () => void;
  loading: boolean;
  placeholder?: string;
}

const MODEL_FOOTER = process.env.NEXT_PUBLIC_OLLAMA_MODEL_LABEL ?? "Bedrock";

export default function ChatInput({ input, onInputChange, onSend, loading, placeholder }: ChatInputProps) {
  const [focused, setFocused] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 180)}px`;
  }, [input]);

  const handleKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      if (!loading && input.trim()) onSend();
    }
  };

  const canSend = !loading && !!input.trim();

  return (
    <div style={{
      borderTop: "1px solid var(--border)",
      background: "var(--surface)",
      padding: "12px 20px 16px",
      flexShrink: 0,
      paddingBottom: "max(16px, env(safe-area-inset-bottom, 16px))",
    }}>
      <div style={{ maxWidth: 760, margin: "0 auto" }}>
        <div
          className={`rvl-input-wrap${focused ? " focused" : ""}`}
          style={{
            display: "flex", alignItems: "flex-end", gap: 8,
            background: "var(--surface-2)",
            border: "1px solid var(--border)",
            borderRadius: 14, padding: "10px 10px 10px 16px",
          }}
        >
          <textarea
            ref={textareaRef}
            rows={1}
            placeholder={placeholder ?? "Ask anything about your machine…"}
            value={input}
            onChange={e => onInputChange(e.target.value)}
            onKeyDown={handleKey}
            disabled={loading}
            onFocus={() => setFocused(true)}
            onBlur={() => setFocused(false)}
            className="rvl-noscroll"
            style={{
              flex: 1, background: "transparent", border: "none", outline: "none",
              resize: "none", color: "var(--text)", fontSize: 14,
              lineHeight: 1.6, fontFamily: "inherit",
              overflowY: "auto", paddingTop: 0, minHeight: 24,
            }}
          />
          <button
            onClick={onSend}
            disabled={!canSend && !loading}
            title={loading ? "Processing…" : "Send (Enter)"}
            style={{
              flexShrink: 0, width: 34, height: 34, borderRadius: "50%",
              border: "none",
              background: loading
                ? "var(--surface-3)"
                : canSend
                  ? "var(--accent)"
                  : "var(--surface-3)",
              display: "flex", alignItems: "center", justifyContent: "center",
              cursor: canSend || loading ? "pointer" : "not-allowed",
              transition: "background .15s, transform .1s",
              transform: canSend ? "scale(1)" : "scale(0.92)",
            }}
          >
            {loading
              ? <Stop size={14} color="var(--text-muted)" variant="Bold" />
              : <ArrowUp size={15} color={canSend ? "#fff" : "var(--text-faint)"} variant="Bold" />
            }
          </button>
        </div>

        <div style={{
          textAlign: "center", fontSize: 10.5,
          color: "var(--text-faint)", marginTop: 8,
          userSelect: "none",
        }}>
          ⏎ Send &nbsp;·&nbsp; ⇧⏎ New line &nbsp;·&nbsp; {MODEL_FOOTER} + RAG
        </div>
      </div>
    </div>
  );
}
