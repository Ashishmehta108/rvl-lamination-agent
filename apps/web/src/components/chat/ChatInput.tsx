import React, { useRef, useEffect, useState, KeyboardEvent } from "react";

// HugeIcons — install: npm i hugeicons-react
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
  const [expanded, setExpanded] = useState(false);
  const [focused, setFocused] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const wrapperRef = useRef<HTMLDivElement>(null);

  // Auto-grow textarea
  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 180)}px`;
  }, [input]);

  // Focus textarea when expanding
  useEffect(() => {
    if (expanded) {
      setTimeout(() => textareaRef.current?.focus(), 120);
    }
  }, [expanded]);

  // Collapse when clicking outside
  useEffect(() => {
    const handleOutside = (e: MouseEvent) => {
      if (
        wrapperRef.current &&
        !wrapperRef.current.contains(e.target as Node) &&
        !input &&
        !loading
      ) {
        setExpanded(false);
        setFocused(false);
      }
    };
    document.addEventListener("mousedown", handleOutside);
    return () => document.removeEventListener("mousedown", handleOutside);
  }, [input, loading]);

  const handleArrowClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (!expanded) {
      setExpanded(true);
    } else if (!loading && input.trim()) {
      onSend();
    }
  };

  const handleKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      if (!loading && input.trim()) onSend();
    }
    if (e.key === "Escape") {
      if (!input) {
        setExpanded(false);
        setFocused(false);
      }
    }
  };

  const canSend = !loading && !!input.trim();
  // Show full expanded UI: user clicked arrow, or is typing, or agent is loading
  const isOpen = expanded || !!input || loading;

  return (
    <>
      <style jsx global>{`
        /* ─── Keyframes ─── */
        @keyframes rvl-pop-in {
          0%   { transform: scale(0.78) translateY(6px); opacity: 0; }
          60%  { transform: scale(1.04) translateY(-1px); opacity: 1; }
          100% { transform: scale(1) translateY(0); opacity: 1; }
        }
        @keyframes rvl-pop-out {
          0%   { transform: scale(1); opacity: 1; }
          100% { transform: scale(0.82) translateY(4px); opacity: 0; }
        }
        @keyframes rvl-btn-pulse {
          0%   { box-shadow: 0 0 0 0 color-mix(in srgb, var(--accent) 55%, transparent); }
          70%  { box-shadow: 0 0 0 9px color-mix(in srgb, var(--accent) 0%, transparent); }
          100% { box-shadow: 0 0 0 0 color-mix(in srgb, var(--accent) 0%, transparent); }
        }
        @keyframes rvl-shimmer {
          0%   { background-position: -200% center; }
          100% { background-position: 200% center; }
        }

        /* ─── Outer bar ─── */
        .rvl-bar {
          display: flex;
          align-items: center;
          justify-content: flex-end;
          gap: 0;
          position: relative;
        }

        /* ─── Collapsed: just the glowing orb button ─── */
        .rvl-orb {
          width: 40px; height: 40px;
          border-radius: 50%;
          border: none;
          display: flex; align-items: center; justify-content: center;
          background: var(--accent);
          cursor: pointer;
          box-shadow: 0 2px 14px color-mix(in srgb, var(--accent) 45%, transparent);
          transition:
            transform .18s cubic-bezier(.22,1,.36,1),
            box-shadow .18s;
          flex-shrink: 0;
          z-index: 2;
        }
        .rvl-orb:hover {
          transform: scale(1.12);
          box-shadow: 0 4px 20px color-mix(in srgb, var(--accent) 55%, transparent);
        }
        .rvl-orb:active {
          transform: scale(0.95);
        }
        /* pulse on first render */
        .rvl-orb.pulse {
          animation: rvl-btn-pulse 1.1s ease-out;
        }

        /* ─── Expanded card ─── */
        .rvl-cin {
          position: absolute;
          bottom: 0; right: 0;
          width: 0;
          overflow: hidden;
          pointer-events: none;
          opacity: 0;
          transform-origin: bottom right;
          transform: scale(0.88) translateY(8px);
          transition:
            width    .32s cubic-bezier(.22,1,.36,1),
            opacity  .22s ease,
            transform .28s cubic-bezier(.22,1,.36,1);
          border-radius: 20px;
        }
        .rvl-cin.open {
          /* expands to full width (minus orb gutter) */
          width: calc(100% - 0px);
          pointer-events: all;
          opacity: 1;
          transform: scale(1) translateY(0);
        }

        .rvl-cin-inner {
          display: flex;
          align-items: flex-end;
          gap: 8px;
          background: var(--surface);
          border: 1px solid color-mix(in srgb, var(--accent) 35%, var(--border));
          border-radius: 20px;
          padding: 10px 8px 10px 16px;
          box-shadow:
            0 0 0 3px color-mix(in srgb, var(--accent) 10%, transparent),
            0 4px 24px rgba(0,0,0,.10);
          /* shimmer border on open */
          animation: rvl-pop-in .3s cubic-bezier(.22,1,.36,1) both;
        }

        /* ─── Textarea ─── */
        .rvl-ta {
          flex: 1;
          background: transparent; border: none; outline: none;
          resize: none; color: var(--text);
          font-size: 14px; line-height: 1.6;
          font-family: inherit;
          overflow-y: auto; min-height: 24px;
          transition: opacity .2s;
          padding-top: 2px;
        }
        .rvl-ta::placeholder { color: var(--text-faint); }

        /* ─── Send button inside expanded ─── */
        .rvl-send-btn {
          flex-shrink: 0;
          width: 32px; height: 32px;
          border-radius: 50%;
          border: none;
          display: flex; align-items: center; justify-content: center;
          cursor: pointer;
          transition:
            background .18s,
            transform  .16s cubic-bezier(.22,1,.36,1),
            box-shadow .18s;
        }
        .rvl-send-btn.ready {
          background: var(--accent);
          transform: scale(1.08);
          box-shadow: 0 2px 10px color-mix(in srgb, var(--accent) 45%, transparent);
          animation: rvl-btn-pulse .7s ease-out;
        }
        .rvl-send-btn.idle {
          background: var(--surface-2);
          transform: scale(0.92);
        }
        .rvl-send-btn.busy {
          background: var(--surface-3);
        }

        /* ─── Footer hint ─── */
        .rvl-hint {
          overflow: hidden; max-height: 0; opacity: 0;
          transition: max-height .28s cubic-bezier(.22,1,.36,1), opacity .18s ease .06s;
        }
        .rvl-hint.show { max-height: 28px; opacity: 1; }
      `}</style>

      <div
        style={{
          borderTop: "1px solid var(--border-subtle)",
          background: "linear-gradient(to top, var(--bg) 58%, transparent)",
          padding: "4px 20px 14px",
          flexShrink: 0,
          paddingBottom: "max(14px, env(safe-area-inset-bottom, 14px))",
        }}
      >
        <div style={{ maxWidth: 720, margin: "0 auto" }}>

          {/* ── Bar: orb + expanding card ── */}
          <div className="rvl-bar" ref={wrapperRef} style={{ minHeight: 40 }}>

            {/* Collapsed orb — always rendered, fades behind the card */}
            {!isOpen && (
              <button
                className="rvl-orb pulse"
                onClick={handleArrowClick}
                title="Open chat input"
                aria-label="Open chat input"
              >
                <ArrowUp02Icon size={18} color="#fff" strokeWidth={2.2} />
              </button>
            )}

            {/* Expanding input card */}
            <div className={`rvl-cin ${isOpen ? "open" : ""}`}>
              <div className="rvl-cin-inner">
                <textarea
                  ref={textareaRef}
                  rows={1}
                  placeholder={placeholder ?? "Ask anything…"}
                  value={input}
                  onChange={e => onInputChange(e.target.value)}
                  onKeyDown={handleKey}
                  disabled={loading}
                  onFocus={() => setFocused(true)}
                  onBlur={() => setFocused(false)}
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
                    ? <StopIcon size={13} color="var(--text-muted)" strokeWidth={2} />
                    : <ArrowUp02Icon
                      size={15}
                      color={canSend ? "#fff" : "var(--text-faint)"}
                      strokeWidth={2.2}
                    />
                  }
                </button>
              </div>
            </div>

          </div>

          {/* Footer hint */}
          <div className={`rvl-hint ${isOpen ? "show" : ""}`}>
            <div style={{
              textAlign: "center", fontSize: 10,
              color: "var(--text-faint)", marginTop: 6,
              userSelect: "none", letterSpacing: "0.02em",
            }}>
              ⏎ Send &nbsp;·&nbsp; ⇧⏎ New line &nbsp;·&nbsp; {MODEL_FOOTER}
            </div>
          </div>

        </div>
      </div>
    </>
  );
}