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
    <div style={{ marginBottom: 12 }}>
      <button
        type="button"
        onClick={() => setOpen(!open)}
        style={{
          display: "inline-flex",
          alignItems: "center",
          gap: 6,
          fontSize: 11,
          fontWeight: 500,
          color: "var(--text-muted)",
          background: "var(--surface-2)",
          border: "1px solid var(--border)",
          borderRadius: 8,
          padding: "5px 12px 5px 10px",
          cursor: "pointer",
          fontFamily: "inherit",
          transition: "all .2s"
        }}
      >
        <DocumentText size={12} color="currentColor" variant="Bulk" />
        Injected context ({blocks.length}
        {liveTagCount != null ? ` · ~${liveTagCount} tag lines` : ""})
        <ChevronIcon up={open} />
      </button>
      {open && (
        <div
          style={{
            marginTop: 8,
            borderLeft: "2px solid var(--accent)",
            marginLeft: 8,
            paddingLeft: 12,
            display: "flex",
            flexDirection: "column",
            gap: 10,
            animation: "rvl-fadein .3s ease both"
          }}
        >
          {blocks.map((b, i) => (
            <div key={i} style={{ background: "var(--surface-2)", padding: "8px 12px", borderRadius: 8, border: "1px solid var(--border)" }}>
              <div style={{ fontSize: 10, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.03em", color: "var(--accent)", marginBottom: 6 }}>{b.source}</div>
              <pre
                style={{
                  margin: 0,
                  fontSize: 10.5,
                  whiteSpace: "pre-wrap",
                  wordBreak: "break-word",
                  color: "var(--text-muted)",
                  maxHeight: 180,
                  overflow: "auto",
                  lineHeight: 1.5,
                  fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace"
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
    <div style={{ marginBottom: 10 }}>
      <button
        onClick={() => setOpen(!open)}
        style={{
          display: "inline-flex", alignItems: "center", gap: 7,
          fontSize: 11, fontWeight: 500, color: "var(--text-muted)", background: "var(--surface-2)",
          border: "1px solid var(--border)", borderRadius: 8, padding: "5px 12px 5px 10px",
          cursor: "pointer", fontFamily: "inherit", transition: "all .2s",
          lineHeight: 1.5
        }}
      >
        <ClockIcon />
        <span>Built in {totalLabel} · {steps.length} steps</span>
        <ChevronIcon up={open} />
      </button>

      {open && (
        <div style={{
          marginTop: 8, borderLeft: "2px solid var(--border)",
          marginLeft: 8, paddingLeft: 14, display: "flex", flexDirection: "column", gap: 6,
          animation: "rvl-fadein .2s ease both"
        }}>
          {steps.map((step, i) => (
            <div key={i} style={{
              display: "flex", alignItems: "center", gap: 10, fontSize: 12,
              color: "var(--text-muted)", animation: "rvl-fadein .2s ease both",
              animationDelay: `${i * 0.05}s`
            }}>
              <div style={{
                width: 20, height: 20, borderRadius: 6, flexShrink: 0,
                background: step.tool === "llm" ? "var(--accent-faint)" : "var(--surface-2)",
                border: "1px solid var(--border)",
                display: "flex", alignItems: "center", justifyContent: "center",
                color: step.tool === "llm" ? "var(--accent)" : "var(--text-muted)",
                boxShadow: step.tool === "llm" ? "0 2px 4px -1px color-mix(in srgb, var(--accent) 20%, transparent)" : "none"
              }}>
                <ToolIcon tool={step.tool} />
              </div>
              <span style={{ flex: 1 }}>{step.label}</span>
              <span style={{ fontSize: 10.5, color: "var(--text-faint)", fontFamily: "monospace", opacity: 0.8 }}>
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
            background: "var(--surface-3)",
            padding: "2px 5px",
            borderRadius: 5,
            fontSize: "0.92em",
            border: "1px solid var(--border)",
            color: "var(--accent)",
            fontWeight: 500,
            fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace"
          }}
          {...rest}
        >
          {children}
        </code>
      );
    }
    return (
      <div style={{ position: "relative", margin: "14px 0" }}>
        <pre
          style={{
            margin: 0,
            padding: "16px 20px",
            overflow: "auto",
            background: "var(--surface-2)",
            border: "1px solid var(--border)",
            borderRadius: 12,
            fontSize: 13,
            lineHeight: 1.6,
            boxShadow: "inset 0 1px 4px rgba(0,0,0,0.02)",
            fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace"
          }}
        >
          <code className={className} {...rest}>
            {children}
          </code>
        </pre>
      </div>
    );
  },
  a: (props: React.ComponentPropsWithoutRef<"a">) => (
    <a {...props} style={{ color: "var(--accent)", textDecoration: "none", borderBottom: "1px solid color-mix(in srgb, var(--accent) 30%, transparent)", fontWeight: 500, transition: "all .2s" }} rel="noopener noreferrer" target="_blank" />
  ),
  ul: (props: React.ComponentPropsWithoutRef<"ul">) => <ul {...props} style={{ margin: "10px 0", paddingLeft: 24, listStyleType: "disc" }} />,
  ol: (props: React.ComponentPropsWithoutRef<"ol">) => <ol {...props} style={{ margin: "10px 0", paddingLeft: 24 }} />,
  li: (props: React.ComponentPropsWithoutRef<"li">) => <li {...props} style={{ margin: "6px 0", lineHeight: 1.8 }} />,
  h2: (props: React.ComponentPropsWithoutRef<"h2">) => (
    <h2 {...props} style={{ fontSize: 17, margin: "20px 0 10px", fontWeight: 700, color: "var(--text)", letterSpacing: "-0.01em" }} />
  ),
  h3: (props: React.ComponentPropsWithoutRef<"h3">) => (
    <h3 {...props} style={{ fontSize: 15, margin: "16px 0 8px", fontWeight: 600, color: "var(--text)" }} />
  ),
  p: (props: React.ComponentPropsWithoutRef<"p">) => <p {...props} style={{ margin: "10px 0", lineHeight: 1.8 }} />,
  table: (props: React.ComponentPropsWithoutRef<"table">) => (
    <div style={{ overflow: "auto", margin: "16px 0", borderRadius: 10, border: "1px solid var(--border)", boxShadow: "0 2px 10px -4px rgba(0,0,0,0.05)" }}>
      <table {...props} style={{ borderCollapse: "collapse", width: "100%", fontSize: 13.5 }} />
    </div>
  ),
  th: (props: React.ComponentPropsWithoutRef<"th">) => (
    <th {...props} style={{ borderBottom: "1px solid var(--border)", borderRight: "1px solid var(--border)", padding: "10px 12px", textAlign: "left", background: "var(--surface-3)", fontWeight: 600, color: "var(--text)" }} />
  ),
  td: (props: React.ComponentPropsWithoutRef<"td">) => (
    <td {...props} style={{ borderBottom: "1px solid var(--border)", borderRight: "1px solid var(--border)", padding: "10px 12px", color: "var(--text-muted)", lineHeight: 1.5 }} />
  ),
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

export default function MessageItem({ msg, isLast }: MessageItemProps) {
  const isAssistant = msg.role === "assistant";

  if (!isAssistant) {
    return (
<<<<<<< HEAD
      <div className="rvl-msg" style={{ display: "flex", justifyContent: "flex-end", gap: 8, padding: "6px 0", alignItems: "flex-end" }}>
        <div className="rvl-msg-actions"><CopyBtn text={msg.content} /></div>
        <div className="rvl-user-bubble" style={{ maxWidth: "78%", background: "var(--surface-2)", border: "1px solid var(--border)", borderRadius: "20px 20px 4px 20px", padding: "12px 18px", fontSize: 14, lineHeight: 1.7, color: "var(--text)", whiteSpace: "pre-wrap", wordBreak: "break-word" }}>
=======
      <div className="rvl-msg" style={{ 
        display: "flex", 
        justifyContent: "flex-end", 
        gap: 12, 
        padding: "10px 0", 
        alignItems: "flex-end" 
      }}>
        <div style={{ marginBottom: 6, opacity: 0.6 }}><CopyBtn text={msg.content} /></div>
        <div 
          className="rvl-msg-bubble" 
          style={{
            maxWidth: "75%",
            background: "var(--surface-3)",
            border: "1px solid var(--border)",
            borderRadius: "20px 20px 4px 20px",
            padding: "12px 20px",
            fontSize: 15,
            lineHeight: 1.6,
            color: "var(--text)",
            whiteSpace: "pre-wrap",
            wordBreak: "break-word",
            boxShadow: "0 4px 15px -3px rgba(0,0,0,0.04), 0 2px 6px -2px rgba(0,0,0,0.02)",
            position: "relative"
          }}
        >
>>>>>>> 02e08f3b3b29dbb0b5a0b41abe1bbec91470b0ad
          {msg.content}
        </div>
      </div>
    );
  }

  return (
<<<<<<< HEAD
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
=======
    <div className="rvl-msg" style={{ 
      display: "flex", 
      alignItems: "flex-start", 
      gap: 16, 
      padding: "16px 0",
      borderBottom: isLast ? "none" : "1px solid var(--border-faint)"
    }}>
      <div style={{
        flexShrink: 0,
        marginTop: 6,
        width: 32,
        height: 32,
        borderRadius: 10,
        background: "var(--accent-faint)",
        border: "1px solid color-mix(in srgb, var(--accent) 20%, transparent)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        boxShadow: "0 4px 10px -4px color-mix(in srgb, var(--accent) 20%, transparent)"
      }}>
        <Cpu size={16} color="var(--accent)" variant="Bulk" />
      </div>
      <div style={{ flex: 1, minWidth: 0, paddingTop: 4 }}>
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
          <div className="rvl-msg-bubble" style={{ maxWidth: "85%" }}>
            <AssistantMarkdown content={msg.content} />
          </div>
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
>>>>>>> 02e08f3b3b29dbb0b5a0b41abe1bbec91470b0ad
                [{c.index}] {c.sourceUri ?? c.chunkId}
              </span>
            ))}
          </div>
        )}
<<<<<<< HEAD
        <div className="rvl-msg-actions" style={{ marginTop: 6 }}><CopyBtn text={msg.content} /></div>
=======

        <div style={{ marginTop: 6 }}><CopyBtn text={msg.content} /></div>
>>>>>>> 02e08f3b3b29dbb0b5a0b41abe1bbec91470b0ad
      </div>
    </div>
  );
}
