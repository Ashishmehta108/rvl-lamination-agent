import React, { useState } from "react";
import { TickCircle, Copy } from "iconsax-reactjs";

interface CopyBtnProps {
  text: string;
}

export default function CopyBtn({ text }: CopyBtnProps) {
  const [copied, setCopied] = useState(false);
  const copy = () => {
    navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 1800);
  };

  return (
    <button onClick={copy} title="Copy" style={{
      background: "none", border: "1px solid transparent", cursor: "pointer", padding: 5, borderRadius: 6, color: "var(--text-faint)", display: "flex", alignItems: "center", transition: "all .15s ease"
    }}
    onMouseEnter={e => { (e.currentTarget as HTMLElement).style.borderColor = "var(--border)"; (e.currentTarget as HTMLElement).style.background = "var(--surface-2)"; }}
    onMouseLeave={e => { (e.currentTarget as HTMLElement).style.borderColor = "transparent"; (e.currentTarget as HTMLElement).style.background = "none"; }}
    >
      {copied ? <TickCircle size={14} color="var(--accent)" variant="Bulk" /> : <Copy size={14} color="currentColor" />}
    </button>
  );
}
