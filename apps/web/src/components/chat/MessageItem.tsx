import React, { useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import rehypeKatex from "rehype-katex";
import "katex/dist/katex.min.css";
import { Cpu, DocumentText, Flash, SearchNormal1, TickCircle } from "iconsax-reactjs";
import { Message, ToolStep, type ContextBlock } from "../../hooks/useChat";
import CopyBtn from "./CopyBtn";
import MessageCharts from "./MessageCharts";

interface MessageItemProps {
  msg: Message;
  isLast: boolean;
}

/* ── SVG Icons ── */
const DbIcon = () => (
  <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
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

function ToolIcon({ tool }: { tool: string }) {
  if (tool === "rag_search" || tool === "find_tags") return <SearchNormal1 size={11} color="currentColor" variant="Bold" />;
  if (tool === "planner") return <DocumentText size={11} color="currentColor" variant="Bold" />;
  if (tool.includes("tag")) return <DbIcon />;
  if (tool.includes("alert")) return <Flash size={11} color="currentColor" variant="Bold" />;
  if (tool.includes("report")) return <DocumentText size={11} color="currentColor" variant="Bold" />;
  if (tool === "llm") return <Cpu size={11} color="currentColor" variant="Bold" />;
  return <DbIcon />;
}

function cleanResponseText(text: string): string {
  let cleaned = text;
  // Remove technical tag comments
  cleaned = cleaned.replace(/^.*tagId\s*`[^`]+`.*$/gm, "");
  cleaned = cleaned.replace(/(?:\(Live\s+)?Tag\s+ID\s+[`(]?[\w-]+[`)h]?/gi, "");
  cleaned = cleaned.replace(/\s*[—–-]\s*tag_[\w-]+/g, "");
  
  // Replace em-dash/en-dash with natural phrasing for common cases
  cleaned = cleaned.replace(/\s+[—–]\s+no\s+open\s+alerts/gi, " with no open alerts");
  cleaned = cleaned.replace(/\s+[—–]\s+line\s+is\s+clear/gi, ", line is clear");
  cleaned = cleaned.replace(/\s+[—–]\s+list\s+only/gi, ": list only");
  
  // Standardize other em-dashes/en-dashes to a clean comma or simple hyphen
  cleaned = cleaned.replace(/\s+[—–]\s+/g, ", ");
  cleaned = cleaned.replace(/[—–]/g, "-");
  
  // Clean multiple line breaks
  cleaned = cleaned.replace(/\n{3,}/g, "\n\n").trim();
  return cleaned;
}

/* ── Markdown component overrides (layout via globals.css .rvl-chat-md) ── */
const mdComponents = {
  code(props: React.ComponentPropsWithoutRef<"code">) {
    const { children, className, ...rest } = props as React.ComponentPropsWithoutRef<"code"> & {
      className?: string;
    };
    const isFenced = typeof className === "string" && className.includes("language-");
    if (!isFenced) {
      return <code {...rest}>{children}</code>;
    }
    return (
      <pre>
        <code className={className} {...rest}>{children}</code>
      </pre>
    );
  },
  a: (props: React.ComponentPropsWithoutRef<"a">) => (
    <a {...props} rel="noopener noreferrer" target="_blank" />
  ),
  table: (props: React.ComponentPropsWithoutRef<"table">) => (
    <div className="rvl-md-table-wrap">
      <table {...props} />
    </div>
  ),
  hr: () => <hr style={{ border: "none", borderTop: "1px solid var(--border-subtle)", margin: "1.25em 0" }} />,
};

/* ── Steps panel with Vercel-style shimmer rows ── */
function StepsPanel({ steps }: { steps: ToolStep[] }) {
  const [open, setOpen] = useState(false);
  const totalMs = steps.reduce((s, t) => s + t.durationMs, 0);
  const totalLabel = totalMs < 1000 ? `${totalMs}ms` : `${(totalMs / 1000).toFixed(1)}s`;

  return (
    <div style={{ marginBottom: 8 }}>
      <button
        type="button"
        onClick={() => setOpen(!open)}
        style={{
          display: "inline-flex", alignItems: "center", gap: 6,
          fontSize: 11, color: "var(--text-muted)",
          background: "var(--surface-2)", border: "1px solid var(--border)",
          borderRadius: 7, padding: "4px 10px 4px 8px",
          cursor: "pointer", fontFamily: "inherit",
          transition: "background .13s",
        }}
        onMouseEnter={e => (e.currentTarget.style.background = "var(--surface-3)")}
        onMouseLeave={e => (e.currentTarget.style.background = "var(--surface-2)")}
      >
        <ClockIcon />
        <span>Built in {totalLabel} · {steps.length} {steps.length === 1 ? "step" : "steps"}</span>
        <ChevronIcon up={open} />
      </button>

      {open && (
        <div style={{
          marginTop: 8, borderLeft: "2px solid var(--border)",
          marginLeft: 4, paddingLeft: 14,
          display: "flex", flexDirection: "column", gap: 5,
        }}>
          {steps.map((step, i) => (
            <div key={i} style={{
              display: "flex", alignItems: "center", gap: 9, fontSize: 12,
              color: step.status === "error" ? "#ef4444" : "var(--text-muted)",
              animation: "rvl-fadein .2s ease both",
              animationDelay: `${i * 0.05}s`,
            }}>
              <div style={{
                width: 20, height: 20, borderRadius: 5, flexShrink: 0,
                background: step.tool === "llm" ? "var(--accent-faint)" : "var(--surface-2)",
                border: "1px solid var(--border)",
                display: "flex", alignItems: "center", justifyContent: "center",
                color: step.tool === "llm" ? "var(--accent)" : "var(--text-muted)",
              }}>
                <ToolIcon tool={step.tool} />
              </div>
              <span style={{ flex: 1 }}>{step.label}</span>
              <span style={{
                fontSize: 10.5, color: "var(--text-faint)",
                fontFamily: "ui-monospace, monospace",
                background: "var(--surface-2)",
                padding: "1px 6px", borderRadius: 4,
              }}>
                {step.durationMs < 1000 ? `${step.durationMs}ms` : `${(step.durationMs / 1000).toFixed(1)}s`}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/* ── Context blocks ── */
function ContextBlocksPanel({ blocks, liveTagCount }: { blocks: ContextBlock[]; liveTagCount?: number }) {
  const [open, setOpen] = useState(false);
  return (
    <div style={{ marginBottom: 8 }}>
      <button type="button" onClick={() => setOpen(!open)} style={{
        display: "inline-flex", alignItems: "center", gap: 5,
        fontSize: 11, color: "var(--text-muted)",
        background: "var(--surface-2)", border: "1px solid var(--border)",
        borderRadius: 7, padding: "4px 10px 4px 8px",
        cursor: "pointer", fontFamily: "inherit",
      }}>
        Injected context ({blocks.length}{liveTagCount != null ? ` · ~${liveTagCount} tag lines` : ""})
        <ChevronIcon up={open} />
      </button>
      {open && (
        <div style={{
          marginTop: 6, borderLeft: "2px solid var(--accent)",
          marginLeft: 4, paddingLeft: 12,
          display: "flex", flexDirection: "column", gap: 8,
        }}>
          {blocks.map((b, i) => (
            <div key={i}>
              <div style={{ fontSize: 10, fontWeight: 600, color: "var(--accent)", marginBottom: 4 }}>{b.source}</div>
              <pre style={{
                margin: 0, fontSize: 10, whiteSpace: "pre-wrap",
                wordBreak: "break-word", color: "var(--text-muted)",
                maxHeight: 140, overflow: "auto",
              }}>{b.preview}</pre>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/* ── Markdown renderer ── */
function AssistantMarkdown({ content }: { content: string }) {
  return (
    <div
      className="rvl-chat-md"
      style={{ animation: "rvl-fadein .3s ease both" }}
    >
      <ReactMarkdown
        remarkPlugins={[remarkGfm, remarkMath]}
        rehypePlugins={[[rehypeKatex, { strict: false, throwOnError: false }]]}
        skipHtml
        components={mdComponents as React.ComponentProps<typeof ReactMarkdown>["components"]}
      >
        {cleanResponseText(content)}
      </ReactMarkdown>
    </div>
  );
}

/* ── Main component ── */
export default function MessageItem({ msg }: MessageItemProps) {
  const isAssistant = msg.role === "assistant";

  /* User message */
  if (!isAssistant) {
    return (
      <div className="rvl-msg" style={{
        display: "flex", justifyContent: "flex-end",
        gap: 8, padding: "6px 0", alignItems: "flex-end",
      }}>
        <CopyBtn text={msg.content} />
        <div style={{
          maxWidth: "75%",
          background: "var(--surface-2)",
          border: "1px solid var(--border)",
          borderRadius: "18px 18px 4px 18px",
          padding: "10px 16px",
          fontSize: 14, lineHeight: 1.7, color: "var(--text)",
          whiteSpace: "pre-wrap", wordBreak: "break-word",
        }}>
          {msg.content}
        </div>
      </div>
    );
  }

  /* Assistant message */
  return (
    <div className="rvl-msg" style={{
      display: "flex", alignItems: "flex-start",
      gap: 12, padding: "8px 0",
    }}>
      {/* Avatar */}
      <div style={{
        flexShrink: 0, marginTop: 2,
        width: 28, height: 28, borderRadius: 8,
        background: "var(--accent-faint)",
        border: "1px solid color-mix(in srgb, var(--accent) 30%, transparent)",
        display: "flex", alignItems: "center", justifyContent: "center",
      }}>
        <Cpu size={14} color="var(--accent)" variant="Bulk" />
      </div>

      {/* Content */}
      <div style={{ flex: 1, minWidth: 0, paddingTop: 2 }}>

        {msg.steps && msg.steps.length > 0 && <StepsPanel steps={msg.steps} />}

        {msg.contextBlocks && msg.contextBlocks.length > 0 && (
          <ContextBlocksPanel blocks={msg.contextBlocks} liveTagCount={msg.liveTagCount} />
        )}

        {msg.findCandidates && msg.findCandidates.length > 0 && (
          <div style={{ marginBottom: 10, display: "flex", flexWrap: "wrap", gap: 6, alignItems: "center" }}>
            <span style={{ fontSize: 10, color: "var(--text-muted)", fontWeight: 600 }}>Tag matches</span>
            {msg.findCandidates.map(c => (
              <span key={c.tagId} title={`${c.name} · score ${c.score.toFixed(1)}${c.unit ? ` · ${c.unit}` : ""}`} style={{
                fontSize: 11, background: "var(--surface-2)", border: "1px solid var(--border)",
                borderRadius: 16, padding: "3px 10px", color: "var(--text-muted)",
                fontFamily: "ui-monospace, monospace",
              }}>
                {c.slug}
              </span>
            ))}
          </div>
        )}

        {msg.error ? (
          <div style={{ fontSize: 14, lineHeight: 1.75, color: "#ef4444", whiteSpace: "pre-wrap", wordBreak: "break-word" }}>
            {msg.content}
          </div>
        ) : (
          <AssistantMarkdown content={msg.content} />
        )}

        {msg.charts && msg.charts.length > 0 && (
          <MessageCharts charts={msg.charts} />
        )}

        {!msg.error && (msg.grounded !== undefined || (msg.citations && msg.citations.length > 0)) && (
          <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 6, marginTop: 10 }}>
            {msg.grounded !== undefined && (
              <span title={msg.grounded ? "Response backed by live data" : "No matching data found"} style={{
                display: "inline-flex", alignItems: "center", gap: 4,
                fontSize: 10.5, borderRadius: 6, padding: "3px 9px",
                background: msg.grounded
                  ? "color-mix(in srgb,#22c55e 10%,transparent)"
                  : "color-mix(in srgb,#f59e0b 10%,transparent)",
                border: `1px solid ${msg.grounded
                  ? "color-mix(in srgb,#22c55e 25%,transparent)"
                  : "color-mix(in srgb,#f59e0b 25%,transparent)"}`,
                color: msg.grounded ? "#22c55e" : "#f59e0b",
                fontWeight: 500,
              }}>
                {msg.grounded
                  ? <><TickCircle size={10} color="#22c55e" variant="Bold" /> Grounded</>
                  : "Ungrounded"
                }
              </span>
            )}
            {msg.citations && msg.citations.map((c, i) => (
              <span key={i} title={c.sourceUri ?? c.chunkId} style={{
                fontSize: 10.5, background: "var(--surface-2)", border: "1px solid var(--border)",
                borderRadius: 6, padding: "3px 9px", color: "var(--accent)",
                maxWidth: 200, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
              }}>
                [{c.index}] {c.sourceUri ?? c.chunkId}
              </span>
            ))}
          </div>
        )}

        <div style={{ marginTop: 8 }}>
          <CopyBtn text={msg.content} />
        </div>
      </div>
    </div>
  );
}
