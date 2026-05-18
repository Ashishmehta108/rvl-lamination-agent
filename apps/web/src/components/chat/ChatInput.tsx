import React, { useRef, useEffect, useState, KeyboardEvent } from "react";
import { ArrowUp02Icon, StopIcon } from "hugeicons-react";

interface ChatInputProps {
  input: string;
  onInputChange: (val: string) => void;
  onSend: () => void;
  loading: boolean;
  placeholder?: string;
}

const MODEL_FOOTER = process.env.NEXT_PUBLIC_OLLAMA_MODEL_LABEL ?? "Bedrock";

export default function ChatInput({
  input,
  onInputChange,
  onSend,
  loading,
  placeholder,
}: ChatInputProps) {
  const [focused, setFocused] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const wrapperRef = useRef<HTMLDivElement>(null);

  /* isOpen: bar is expanded */
  const isOpen = focused || !!input || loading;
  const canSend = !loading && !!input.trim();

  /* Auto-grow height (caps at 120px) */
  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 120)}px`;
  }, [input]);

  /* Clicking anywhere on the bar focuses the textarea */
  const handleBarClick = () => {
    setFocused(true);
    setTimeout(() => textareaRef.current?.focus(), 30);
  };

  /* Collapse when clicking outside + no content */
  useEffect(() => {
    const handleOutside = (e: MouseEvent) => {
      if (
        wrapperRef.current &&
        !wrapperRef.current.contains(e.target as Node) &&
        !input &&
        !loading
      ) {
        setFocused(false);
      }
    };
    document.addEventListener("mousedown", handleOutside);
    return () => document.removeEventListener("mousedown", handleOutside);
  }, [input, loading]);

  const handleKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      if (canSend) onSend();
    }
    if (e.key === "Escape" && !input) {
      setFocused(false);
    }
  };

  return (
    <>
      <style jsx global>{`
        /* ── Send button pulse ── */
        @keyframes rvl-btn-pulse {
          0%   { box-shadow: 0 0 0 0   color-mix(in srgb, var(--accent) 55%, transparent); }
          70%  { box-shadow: 0 0 0 8px color-mix(in srgb, var(--accent)  0%, transparent); }
          100% { box-shadow: 0 0 0 0   color-mix(in srgb, var(--accent)  0%, transparent); }
        }

        /* ── Outer centering shell — always full width ── */
        .rvl-input-shell {
          display: flex;
          justify-content: center;
          width: 100%;
        }

        /* ── Input bar — ChatGPT-style width expansion ── */
        .rvl-input-bar {
          display: flex;
          align-items: flex-end;
          gap: 6px;
          border-radius: 20px;
          border: 1px solid var(--border);
          padding: 7px 6px 7px 14px;

          /* collapsed: narrow pill */
          width: 220px;
          max-width: 100%;

          background: transparent;
          cursor: text;

          /* smooth width + visual expansion */
          transition:
            width      .35s cubic-bezier(.4, 0, .2, 1),
            background .22s ease,
            border-color .22s ease,
            box-shadow   .22s ease;
        }

        /* Expanded state — grows to fill container */
        .rvl-input-bar.open {
          width: 100%;
          background: var(--surface);
          border-color: color-mix(in srgb, var(--accent) 35%, var(--border));
          box-shadow:
            0 0 0 3px color-mix(in srgb, var(--accent) 10%, transparent),
            0 2px 12px rgba(0, 0, 0, .06);
          cursor: default;
        }

        /* ── Textarea ── */
        .rvl-ta {
          flex: 1;
          background: transparent;
          border: none;
          outline: none;
          resize: none;
          color: var(--text);
          font-size: 13px;
          line-height: 1.55;
          font-family: inherit;
          overflow-y: auto;
          min-height: 20px;
          padding-top: 1px;
          transition: opacity .2s;
        }
        .rvl-ta::placeholder {
          color: var(--text-faint);
          transition: opacity .2s;
        }

        /* ── Send button ── */
        .rvl-send-btn {
          flex-shrink: 0;
          width: 28px;
          height: 28px;
          border-radius: 50%;
          border: none;
          display: flex;
          align-items: center;
          justify-content: center;
          cursor: pointer;
          transition:
            background .18s,
            transform   .16s cubic-bezier(.22, 1, .36, 1),
            box-shadow  .18s;
        }
        .rvl-send-btn.ready {
          background: var(--accent);
          transform: scale(1.06);
          box-shadow: 0 2px 8px color-mix(in srgb, var(--accent) 40%, transparent);
          animation: rvl-btn-pulse .65s ease-out;
        }
        .rvl-send-btn.idle {
          background: var(--surface-2);
          transform: scale(0.9);
        }
        .rvl-send-btn.busy {
          background: var(--surface-3);
        }

        /* ── Footer hint — fades in with bar ── */
        .rvl-hint {
          overflow: hidden;
          max-height: 0;
          opacity: 0;
          transition:
            max-height .28s cubic-bezier(.22, 1, .36, 1),
            opacity     .18s ease .08s;
        }
        .rvl-hint.show {
          max-height: 24px;
          opacity: 1;
        }
      `}</style>

      {/* ── Bar ── */}
      <div className="rvl-input-shell">
        <div
          ref={wrapperRef}
          className={`rvl-input-bar ${isOpen ? "open" : ""}`}
          onClick={handleBarClick}
        >
          <textarea
            ref={textareaRef}
            rows={1}
            placeholder={isOpen ? (placeholder ?? "Ask anything…") : "Ask…"}
            value={input}
            onChange={e => onInputChange(e.target.value)}
            onKeyDown={handleKey}
            disabled={loading}
            onFocus={() => setFocused(true)}
            onBlur={() => { if (!input && !loading) setFocused(false); }}
            className="rvl-ta rvl-noscroll"
            style={{ opacity: loading ? 0.45 : 1 }}
          />

          {/* Send / Stop */}
          <button
            onClick={e => { e.stopPropagation(); if (canSend || loading) onSend(); }}
            disabled={!canSend && !loading}
            title={loading ? "Processing…" : "Send (Enter)"}
            className={`rvl-send-btn ${loading ? "busy" : canSend ? "ready" : "idle"}`}
          >
            {loading
              ? <StopIcon size={11} color="var(--text-muted)" strokeWidth={2} />
              : <ArrowUp02Icon size={13} color={canSend ? "#fff" : "var(--text-faint)"} strokeWidth={2.2} />
            }
          </button>
        </div>
      </div>


    </>
  );
}