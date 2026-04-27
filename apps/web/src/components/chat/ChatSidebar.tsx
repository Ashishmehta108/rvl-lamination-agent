import React from "react";
import { AddSquare, SidebarLeft, SearchNormal1, Trash } from "iconsax-reactjs";
import { Conversation } from "../../hooks/useChat";

interface ChatSidebarProps {
  open: boolean;
  onClose: () => void;
  onNewChat: () => void;
  search: string;
  onSearchChange: (val: string) => void;
  conversations: Conversation[];
  activeId: string | null;
  onSelect: (id: string) => void;
  onDelete: (id: string) => void;
  /** Narrow screens: fixed drawer over content */
  layout?: "docked" | "overlay";
}

export default function ChatSidebar({
  open,
  onClose,
  onNewChat,
  search,
  onSearchChange,
  conversations,
  activeId,
  onSelect,
  onDelete,
  layout = "docked"
}: ChatSidebarProps) {
  if (!open) return null;

  const overlay = layout === "overlay";

  const groupByDate = (convs: Conversation[]) => {
    const now = Date.now();
    const today: Conversation[] = [], yesterday: Conversation[] = [], week: Conversation[] = [], older: Conversation[] = [];
    convs.forEach(c => {
      const diff = (now - c.updatedAt) / 86400000;
      if (diff < 1) today.push(c);
      else if (diff < 2) yesterday.push(c);
      else if (diff < 7) week.push(c);
      else older.push(c);
    });
    return [
      { label: "Today", items: today },
      { label: "Yesterday", items: yesterday },
      { label: "Last 7 days", items: week },
      { label: "Older", items: older }
    ].filter(g => g.items.length > 0);
  };

  const filtered = conversations.filter(c => c.title.toLowerCase().includes(search.toLowerCase()));
  const groups = groupByDate(filtered);

  return (
    <aside
      className="rvl-sidebar"
      style={{
        width: 252,
        flexShrink: 0,
        overflow: "hidden",
        display: "flex",
        flexDirection: "column",
        background: "var(--surface)",
        borderRight: "1px solid var(--border)",
        ...(overlay
          ? {
              position: "fixed" as const,
              left: 0,
              top: 0,
              height: "100dvh",
              zIndex: 50,
              boxShadow: "8px 0 32px rgba(0,0,0,0.14)",
              maxWidth: "min(280px, 88vw)"
            }
          : {})
      }}
    >
      <div style={{ padding: "14px 12px 10px", display: "flex", alignItems: "center", gap: 8, borderBottom: "1px solid var(--border)", flexShrink: 0 }}>
        <button onClick={onNewChat} style={{
          flex: 1, display: "flex", alignItems: "center", gap: 7, background: "var(--accent)", border: "none", borderRadius: 7,
          padding: "7px 10px", color: "#fff", fontSize: 12.5, fontWeight: 600, cursor: "pointer", fontFamily: "inherit", whiteSpace: "nowrap",
        }}>
          <AddSquare size={14} color="#fff" /> New chat
        </button>
        <button onClick={onClose} title="Close sidebar" style={{ background: "none", border: "none", cursor: "pointer", color: "var(--text-faint)", display: "flex", padding: 5, borderRadius: 6 }}>
          <SidebarLeft size={16} color="currentColor" />
        </button>
      </div>

      <div style={{ padding: "10px 10px 6px", flexShrink: 0 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 7, background: "var(--surface-2)", border: "1px solid var(--border)", borderRadius: 7, padding: "5px 10px" }}>
          <SearchNormal1 size={12} color="var(--text-faint)" />
          <input value={search} onChange={e => onSearchChange(e.target.value)} placeholder="Search…"
            style={{ flex: 1, background: "none", border: "none", outline: "none", fontSize: 12, color: "var(--text)", fontFamily: "inherit", minWidth: 0 }} />
        </div>
      </div>

      <div style={{ flex: 1, overflowY: "auto", padding: "4px 6px" }}>
        {groups.map(group => (
          <div key={group.label}>
            <div style={{ fontSize: 10, fontWeight: 700, letterSpacing: "0.07em", textTransform: "uppercase", color: "var(--text-faint)", padding: "10px 8px 4px", whiteSpace: "nowrap" }}>{group.label}</div>
            {group.items.map(conv => (
              <div key={conv.id} className={`rvl-conv-item${conv.id === activeId ? " active" : ""}`}
                onClick={() => onSelect(conv.id)}
                style={{ display: "flex", alignItems: "center", gap: 6, padding: "8px 8px 8px 10px", borderRadius: 7, cursor: "pointer", background: "transparent", marginBottom: 1, borderLeft: "2px solid transparent" }}>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 12.5, fontWeight: conv.id === activeId ? 600 : 400, color: "var(--text)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{conv.title}</div>
                </div>
                <button className="rvl-del" onClick={e => { e.stopPropagation(); onDelete(conv.id); }}
                  style={{ flexShrink: 0, background: "none", border: "none", cursor: "pointer", padding: 3, borderRadius: 4, color: "var(--text-faint)", opacity: 0 }}>
                  <Trash size={12} color="currentColor" />
                </button>
              </div>
            ))}
          </div>
        ))}
      </div>
    </aside>
  );
}
