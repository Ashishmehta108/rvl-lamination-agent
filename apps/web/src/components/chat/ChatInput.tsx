import React, { useRef, useEffect, useState, KeyboardEvent } from "react";
import { ArrowUp } from "iconsax-reactjs";

interface ChatInputProps {
  input: string;
  onInputChange: (val: string) => void;
  onSend: () => void;
  loading: boolean;
  placeholder?: string;
}

const MODEL_FOOTER = process.env.NEXT_PUBLIC_OLLAMA_MODEL_LABEL ?? "Ollama";

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
    <div className="rvl-input-area" style={{ 
      borderTop: "1px solid var(--border)", 
      background: "var(--bg)", 
      padding: "16px 20px 24px", 
      flexShrink: 0,
      zIndex: 10
    }}>
      <div style={{ maxWidth: 740, margin: "0 auto" }}>
        <div 
          className={focused ? "rvl-input-focused" : ""} 
          style={{
            display: "flex", 
            alignItems: "flex-end", 
            gap: 12, 
            background: "var(--surface-2)", 
            border: `1px solid ${focused ? "var(--accent)" : "var(--border)"}`, 
            borderRadius: 16, 
            padding: "12px 12px 12px 20px", 
            boxShadow: focused 
              ? "0 8px 30px -10px rgba(0,0,0,0.1), 0 0 0 4px color-mix(in srgb, var(--accent) 10%, transparent)" 
              : "0 4px 12px -2px rgba(0,0,0,0.05)", 
            transition: "all .2s cubic-bezier(.4,0,.2,1)"
          }}
        >
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
            style={{ 
              flex: 1, 
              background: "transparent", 
              border: "none", 
              outline: "none", 
              resize: "none", 
              color: "var(--text)", 
              fontSize: 15, 
              lineHeight: 1.6, 
              fontFamily: "inherit", 
              overflowY: "auto", 
              paddingTop: 4, 
              paddingBottom: 4 
            }}
          />
          <button 
            onClick={onSend} 
            disabled={loading || !input.trim()} 
            style={{
              flexShrink: 0, 
              width: 36, 
              height: 36, 
              borderRadius: 11, 
              border: "none", 
              background: loading || !input.trim() ? "var(--surface-3)" : "var(--accent)", 
              display: "flex", 
              alignItems: "center", 
              justifyContent: "center", 
              cursor: loading || !input.trim() ? "not-allowed" : "pointer", 
              transition: "all .25s cubic-bezier(.4,0,.2,1)",
              boxShadow: loading || !input.trim() ? "none" : "0 4px 12px -2px color-mix(in srgb, var(--accent) 40%, transparent)",
              transform: loading ? "scale(0.95)" : "none"
            }}
          >
            <ArrowUp size={20} color="#fff" variant="Bold" />
          </button>
        </div>
        <div style={{ display: "flex", justifyContent: "center", gap: 16, fontSize: 10, color: "var(--text-faint)", marginTop: 12, letterSpacing: "0.02em", fontWeight: 500 }}>
          <span style={{ display: "flex", alignItems: "center", gap: 4 }}><span style={{ border: "1px solid var(--border)", borderRadius: 3, padding: "1px 3px" }}>Enter</span> Send</span>
          <span style={{ display: "flex", alignItems: "center", gap: 4 }}><span style={{ border: "1px solid var(--border)", borderRadius: 3, padding: "1px 3px" }}>Shift + Enter</span> New line</span>
          <span style={{ display: "flex", alignItems: "center", gap: 4 }}>Model: {MODEL_FOOTER}</span>
        </div>
      </div>
    </div>
  );
}
