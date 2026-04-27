import React, { useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeSanitize from "rehype-sanitize";
import { Cpu, DocumentText, Flash, SearchNormal1, TickCircle } from "iconsax-reactjs";
import { Message, ToolStep, type ContextBlock } from "../../hooks/useChat";
import CopyBtn from "./CopyBtn";

interface MessageItemProps {
  msg: Message;
  isLast: boolean;
}

/* ── Inline SVG icons ── */
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
  if (tool === "planner") return <DocumentText size={11} color="currentColor" variant="Bold" />;
  if (tool === "find_tags") return <SearchNormal1 size={11} color="currentColor" variant="Bold" />;
  if (tool === "get_tags" || tool === "tags_db" || tool === "tags_selected") return <DbIcon />;
  if (tool === "get_alerts" || tool === "alerts_db") return <Flash size={11} color="currentColor" variant="Bold" />;
  if (tool === "get_reports" || tool === "reports_db") return <DocumentText size={11} color="currentColor" variant="Bold" />;
  if (tool === "get_production_metrics") return <Cpu size={11} color="currentColor" variant="Bold" />;
  if (tool === "llm") return <Cpu size={11} color="currentColor" variant="Bold" />;
  return <DbIcon />;
}

/**
 * Strip raw machine-readable tag dump lines that can leak through from the LLM.
 * These look like:  "- **SLUG** — value **UNIT** — tagId `xxx` — **timestamp**"
 * or numbered:      "1) **SLUG** — value **UNIT** — tagId `xxx` — **timestamp**"
 * We replace them with a clean inline sentence instead of showing internal IDs.
 */
function cleanResponseText(text: string): string {
  // 1. Remove lines that contain raw tagId backtick patterns
  const tagIdLineRe = /^.*tagId\s*`[^`]+`.*$/gm;
  let cleaned = text.replace(tagIdLineRe, "");

  // 2. Remove "tagId `...`" or "(Live Tag ID ...)" fragments inline
  const tagIdInlineRe = /(?:\(Live\s+)?Tag\s+ID\s+[`(]?[\w-]+[`)h]?/gi;
  cleaned = cleaned.replace(tagIdInlineRe, "");

  // 3. Remove leftover "—" chains or double separators
  cleaned = cleaned.replace(/\s—\s+tag_[\w-]+/g, "");
  cleaned = cleaned.replace(/—\s*—+/g, "—");

  // 4. Collapse multiple blank lines left behind
  cleaned = cleaned.replace(/\n{3,}/g, "\n\n").trim();

  return cleaned;
}

function ContextBlocksPanel({ blocks, liveTagCount }: { blocks: ContextBlock[]; liveTagCount?: number }) {
  const [open, setOpen] = useState(false);
  return (
    <div style={{ marginBottom: 8 }}>
      <button
        type="button"
        onClick={() => setOpen(!open)}
        style={{
          display: "inline-flex",
          alignItems: "center",
          gap: 5,
          fontSize: 11,
          color: "var(--text-muted)",
          background: "var(--surface-2)",
          border: "1px solid var(--border)",
          borderRadius: 6,
          padding: "3px 10px 3px 8px",
          cursor: "pointer",
          fontFamily: "inherit",
        }}
      >
        Injected context ({blocks.length}
        {liveTagCount != null ? ` · ~${liveTagCount} tag lines` : ""})
        <ChevronIcon up={open} />
      </button>
      {open && (
        <div
          style={{
            marginTop: 6,
            borderLeft: "2px solid var(--accent)",
            marginLeft: 8,
            paddingLeft: 10,
            display: "flex",
            flexDirection: "column",
            gap: 8,
          }}
        >
          {blocks.map((b, i) => (
            <div key={i}>
              <div style={{ fontSize: 10, fontWeight: 600, color: "var(--accent)", marginBottom: 4 }}>{b.source}</div>
              <pre
                style={{
                  margin: 0,
                  fontSize: 10,
                  whiteSpace: "pre-wrap",
                  wordBreak: "break-word",
                  color: "var(--text-muted)",
                  maxHeight: 160,
                  overflow: "auto",
                }}
              >
                {b.preview}
              </pre>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/* ── Steps accordion ── */
function StepsPanel({ steps }: { steps: ToolStep[] }) {
  const [open, setOpen] = useState(false);
  const totalMs = steps.reduce((s, t) => s + t.durationMs, 0);
  const totalLabel = totalMs < 1000 ? `${totalMs}ms` : `${(totalMs / 1000).toFixed(1)}s`;

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
        <span>Built in {totalLabel} · {steps.length} steps</span>
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

const mdComponents = {
  code(props: React.ComponentPropsWithoutRef<"code">) {
    const { children, className, ...rest } = props as any;
    const isFenced = typeof className === "string" && className.includes("language-");
    if (!isFenced) {
      return (
        <code
          style={{
            background: "var(--surface-2)",
            padding: "2px 6px",
            borderRadius: 4,
            fontSize: "0.9em",
            border: "1px solid var(--border)",
          }}
          {...rest}
        >
          {children}
        </code>
      );
    }
    return (
      <pre
        style={{
          margin: "10px 0",
          padding: 12,
          overflow: "auto",
          background: "var(--surface-2)",
          border: "1px solid var(--border)",
          borderRadius: 8,
          fontSize: 12,
          lineHeight: 1.5,
        }}
      >
        <code className={className} {...rest}>
          {children}
        </code>
      </pre>
    );
  },
  a: (props: React.ComponentPropsWithoutRef<"a">) => (
    <a {...props} style={{ color: "var(--accent)", textDecoration: "underline" }} rel="noopener noreferrer" target="_blank" />
  ),
  ul: (props: React.ComponentPropsWithoutRef<"ul">) => <ul {...props} style={{ margin: "6px 0", paddingLeft: 20 }} />,
  ol: (props: React.ComponentPropsWithoutRef<"ol">) => <ol {...props} style={{ margin: "6px 0", paddingLeft: 20 }} />,
  li: (props: React.ComponentPropsWithoutRef<"li">) => <li {...props} style={{ margin: "3px 0", lineHeight: 1.7 }} />,
  h2: (props: React.ComponentPropsWithoutRef<"h2">) => (
    <h2 {...props} style={{ fontSize: 15, margin: "14px 0 6px", fontWeight: 600, color: "var(--text)" }} />
  ),
  h3: (props: React.ComponentPropsWithoutRef<"h3">) => (
    <h3 {...props} style={{ fontSize: 14, margin: "10px 0 5px", fontWeight: 600, color: "var(--text)" }} />
  ),
  p: (props: React.ComponentPropsWithoutRef<"p">) => <p {...props} style={{ margin: "6px 0", lineHeight: 1.75 }} />,
  table: (props: React.ComponentPropsWithoutRef<"table">) => (
    <div style={{ overflow: "auto", margin: "10px 0" }}>
      <table {...props} style={{ borderCollapse: "collapse", width: "100%", fontSize: 13 }} />
    </div>
  ),
  th: (props: React.ComponentPropsWithoutRef<"th">) => (
    <th {...props} style={{ border: "1px solid var(--border)", padding: "6px 8px", textAlign: "left", background: "var(--surface-2)" }} />
  ),
  td: (props: React.ComponentPropsWithoutRef<"td">) => (
    <td {...props} style={{ border: "1px solid var(--border)", padding: "6px 8px" }} />
  ),
  // Suppress raw hr separators that models sometimes emit between tag lines
  hr: () => null,
};

function AssistantMarkdown({ content }: { content: string }) {
  const cleaned = cleanResponseText(content);
  return (
    <div
      className="rvl-chat-md"
      style={{
        fontSize: 14,
        lineHeight: 1.75,
        color: "var(--text)",
        wordBreak: "break-word",
        animation: "rvl-fadein .3s ease both",
      }}
    >
      <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeSanitize]} skipHtml components={mdComponents as any}>
        {cleaned}
      </ReactMarkdown>
    </div>
  );
}

export default function MessageItem({ msg }: MessageItemProps) {
  const isAssistant = msg.role === "assistant";

  if (!isAssistant) {
    return (
      <div className="rvl-msg" style={{ display: "flex", justifyContent: "flex-end", gap: 6, padding: "4px 0", alignItems: "flex-end" }}>
        <CopyBtn text={msg.content} />
        <div style={{
          maxWidth: "78%",
          background: "var(--surface-2)",
          border: "1px solid var(--border)",
          borderRadius: "18px 18px 4px 18px",
          padding: "10px 16px",
          fontSize: 14,
          lineHeight: 1.7,
          color: "var(--text)",
          whiteSpace: "pre-wrap",
          wordBreak: "break-word",
          animation: "rvl-fadein .2s ease both",
        }}>
          {msg.content}
        </div>
      </div>
    );
  }

  return (
    <div className="rvl-msg" style={{ display: "flex", alignItems: "flex-start", gap: 12, padding: "4px 0" }}>
      <div style={{
        flexShrink: 0,
        marginTop: 3,
        width: 26,
        height: 26,
        borderRadius: 7,
        background: "var(--accent-faint)",
        border: "1px solid var(--border)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
      }}>
        <Cpu size={13} color="var(--accent)" variant="Bulk" />
      </div>
      <div style={{ flex: 1, minWidth: 0, paddingTop: 3 }}>
        {msg.steps && msg.steps.length > 0 && <StepsPanel steps={msg.steps} />}
        {msg.contextBlocks && msg.contextBlocks.length > 0 && (
          <ContextBlocksPanel blocks={msg.contextBlocks} liveTagCount={msg.liveTagCount} />
        )}

        {msg.findCandidates && msg.findCandidates.length > 0 && (
          <div style={{ marginBottom: 10, display: "flex", flexWrap: "wrap", gap: 6, alignItems: "center" }}>
            <span style={{ fontSize: 10, color: "var(--text-muted)", fontWeight: 600 }}>Tag matches</span>
            {msg.findCandidates.map((c) => (
              <span
                key={c.tagId}
                title={`${c.name} · score ${c.score.toFixed(1)}${c.unit ? ` · ${c.unit}` : ""}`}
                style={{
                  fontSize: 11,
                  background: "var(--surface-2)",
                  border: "1px solid var(--border)",
                  borderRadius: 16,
                  padding: "3px 10px",
                  color: "var(--text-muted)",
                  fontFamily: "ui-monospace, monospace",
                }}
              >
                {c.slug}
              </span>
            ))}
          </div>
        )}

        {msg.error ? (
          <div style={{ fontSize: 14, lineHeight: 1.75, color: "#c45", whiteSpace: "pre-wrap", wordBreak: "break-word" }}>
            {msg.content}
          </div>
        ) : (
          <AssistantMarkdown content={msg.content} />
        )}

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
