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
      background: "none", border: "none", cursor: "pointer", padding: 4, borderRadius: 5, color: "var(--text-faint)", display: "flex", alignItems: "center", transition: "color .15s"
    }}>
      {copied ? <TickCircle size={14} color="var(--accent)" variant="Bulk" /> : <Copy size={14} color="currentColor" />}
    </button>
  );
}
