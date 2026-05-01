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
<<<<<<< HEAD
    <aside className="rvl-sidebar" style={{
      width: 272, flexShrink: 0, overflow: "hidden", display: "flex", flexDirection: "column", background: "var(--surface)", borderRight: "1px solid var(--border)"
    }}>
      <div style={{ padding: "14px 14px 10px", display: "flex", alignItems: "center", gap: 8, borderBottom: "1px solid var(--border)", flexShrink: 0 }}>
        <button onClick={onNewChat} style={{
          flex: 1, display: "flex", alignItems: "center", gap: 8, background: "var(--accent)", border: "none", borderRadius: 10,
          padding: "9px 14px", color: "#fff", fontSize: 13, fontWeight: 600, cursor: "pointer", fontFamily: "inherit", whiteSpace: "nowrap", transition: "all .2s ease",
        }}>
          <AddSquare size={15} color="#fff" /> New chat
        </button>
        <button onClick={onClose} title="Close sidebar" style={{ background: "none", border: "1px solid var(--border)", cursor: "pointer", color: "var(--text-faint)", display: "flex", padding: 7, borderRadius: 8, transition: "all .15s ease" }}>
=======
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
              boxShadow: "8px 0 32px rgba(0,0,0,0.22)",
              maxWidth: "min(300px, 85vw)"
            }
          : {})
      }}
    >
      <div style={{ padding: "16px 12px 12px", display: "flex", alignItems: "center", gap: 8, borderBottom: "1px solid var(--border)", flexShrink: 0 }}>
        <button onClick={onNewChat} className="rvl-chip" style={{
          flex: 1, display: "flex", alignItems: "center", justifyContent: "center", gap: 8, background: "var(--accent)", border: "none", borderRadius: 8,
          padding: "8px 12px", color: "#fff", fontSize: 13, fontWeight: 600, cursor: "pointer", fontFamily: "inherit", whiteSpace: "nowrap",
          boxShadow: "0 2px 8px -2px color-mix(in srgb, var(--accent) 40%, transparent)"
        }}>
          <AddSquare size={16} color="#fff" variant="Bold" /> New chat
        </button>
        <button onClick={onClose} title="Close sidebar" style={{ background: "var(--surface-2)", border: "1px solid var(--border)", cursor: "pointer", color: "var(--text-muted)", display: "flex", padding: 7, borderRadius: 8, transition: "all .2s" }}>
>>>>>>> 02e08f3b3b29dbb0b5a0b41abe1bbec91470b0ad
          <SidebarLeft size={16} color="currentColor" />
        </button>
      </div>

      <div style={{ padding: "12px 12px 8px", flexShrink: 0 }}>
<<<<<<< HEAD
        <div style={{ display: "flex", alignItems: "center", gap: 8, background: "var(--surface-2)", border: "1px solid var(--border)", borderRadius: 10, padding: "7px 12px" }}>
          <SearchNormal1 size={13} color="var(--text-faint)" />
          <input value={search} onChange={e => onSearchChange(e.target.value)} placeholder="Search…"
            style={{ flex: 1, background: "none", border: "none", outline: "none", fontSize: 12.5, color: "var(--text)", fontFamily: "inherit", minWidth: 0 }} />
        </div>
      </div>

      <div style={{ flex: 1, overflowY: "auto", padding: "4px 8px" }}>
        {groups.map(group => (
          <div key={group.label}>
=======
        <div style={{ display: "flex", alignItems: "center", gap: 8, background: "var(--surface-2)", border: "1px solid var(--border)", borderRadius: 8, padding: "6px 12px", transition: "border-color .2s" }}>
          <SearchNormal1 size={14} color="var(--text-faint)" />
          <input value={search} onChange={e => onSearchChange(e.target.value)} placeholder="Search chats…"
            style={{ flex: 1, background: "none", border: "none", outline: "none", fontSize: 13, color: "var(--text)", fontFamily: "inherit", minWidth: 0 }} />
        </div>
      </div>

      <div style={{ flex: 1, overflowY: "auto", padding: "8px 8px", display: "flex", flexDirection: "column", gap: 2 }}>
        {groups.map(group => (
          <div key={group.label} style={{ marginBottom: 8 }}>
>>>>>>> 02e08f3b3b29dbb0b5a0b41abe1bbec91470b0ad
            <div style={{ fontSize: 10, fontWeight: 700, letterSpacing: "0.08em", textTransform: "uppercase", color: "var(--text-faint)", padding: "12px 8px 6px", whiteSpace: "nowrap" }}>{group.label}</div>
            {group.items.map(conv => (
              <div key={conv.id} className={`rvl-conv-item${conv.id === activeId ? " active" : ""}`}
                onClick={() => onSelect(conv.id)}
<<<<<<< HEAD
                style={{ display: "flex", alignItems: "center", gap: 8, padding: "9px 10px 9px 12px", borderRadius: 9, cursor: "pointer", background: "transparent", marginBottom: 2, borderLeft: "2px solid transparent" }}>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 13, fontWeight: conv.id === activeId ? 600 : 400, color: "var(--text)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{conv.title}</div>
                </div>
                <button className="rvl-del" onClick={e => { e.stopPropagation(); onDelete(conv.id); }}
                  style={{ flexShrink: 0, background: "none", border: "none", cursor: "pointer", padding: 4, borderRadius: 5, color: "var(--text-faint)", opacity: 0, transition: "opacity .15s ease" }}>
                  <Trash size={13} color="currentColor" />
=======
                style={{ 
                  display: "flex", alignItems: "center", gap: 10, padding: "10px 10px 10px 12px", borderRadius: 8, 
                  cursor: "pointer", background: "transparent", marginBottom: 2, borderLeft: "2px solid transparent",
                  position: "relative", overflow: "hidden"
                }}>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ 
                    fontSize: 13, 
                    fontWeight: conv.id === activeId ? 600 : 400, 
                    color: conv.id === activeId ? "var(--text)" : "var(--text-muted)", 
                    overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
                    transition: "color .2s"
                  }}>{conv.title}</div>
                </div>
                <button className="rvl-del" onClick={e => { e.stopPropagation(); onDelete(conv.id); }}
                  style={{ 
                    flexShrink: 0, background: "var(--surface-3)", border: "none", cursor: "pointer", 
                    padding: 4, borderRadius: 6, color: "#f43f5e", display: "flex", alignItems: "center", justifyContent: "center"
                  }}>
                  <Trash size={13} color="currentColor" variant="Bold" />
>>>>>>> 02e08f3b3b29dbb0b5a0b41abe1bbec91470b0ad
                </button>
              </div>
            ))}
          </div>
        ))}
      </div>
    </aside>
  );
}
