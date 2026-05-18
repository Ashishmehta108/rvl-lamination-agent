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
  layout?: "docked" | "overlay";
}

function groupByDate(convs: Conversation[]) {
  const now = Date.now();
  const today: Conversation[] = [], yesterday: Conversation[] = [],
    week: Conversation[] = [], older: Conversation[] = [];
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
    { label: "Older", items: older },
  ].filter(g => g.items.length > 0);
}

export default function ChatSidebar({
  onClose, onNewChat, search, onSearchChange,
  conversations, activeId, onSelect, onDelete,
}: ChatSidebarProps) {
  const filtered = conversations.filter(c =>
    c.title.toLowerCase().includes(search.toLowerCase())
  );
  const groups = groupByDate(filtered);

  return (
    <div style={{
      display: "flex", flexDirection: "column",
      height: "100%", width: "100%",
      background: "var(--surface)",
      overflow: "hidden",
    }}>
      {/* Header */}
      <div style={{
        padding: "12px 10px 10px",
        display: "flex", alignItems: "center", gap: 8,
        borderBottom: "1px solid var(--border)",
        flexShrink: 0,
      }}>
        <button
          onClick={onNewChat}
          style={{
            flex: 1, display: "flex", alignItems: "center", gap: 7,
            background: "var(--accent)", border: "none", borderRadius: 8,
            padding: "8px 12px", color: "#fff",
            fontSize: 12.5, fontWeight: 600,
            cursor: "pointer", fontFamily: "inherit", whiteSpace: "nowrap",
            transition: "opacity .15s",
          }}
          onMouseEnter={e => (e.currentTarget.style.opacity = "0.88")}
          onMouseLeave={e => (e.currentTarget.style.opacity = "1")}
        >
          <AddSquare size={14} color="#fff" /> New chat
        </button>
        <button
          onClick={onClose}
          title="Collapse sidebar"
          style={{
            background: "none", border: "1px solid var(--border)",
            cursor: "pointer", color: "var(--text-faint)",
            display: "flex", padding: 7, borderRadius: 7,
            transition: "background .15s, color .15s",
          }}
          onMouseEnter={e => {
            const b = e.currentTarget as HTMLButtonElement;
            b.style.background = "var(--surface-2)";
            b.style.color = "var(--text)";
          }}
          onMouseLeave={e => {
            const b = e.currentTarget as HTMLButtonElement;
            b.style.background = "none";
            b.style.color = "var(--text-faint)";
          }}
        >
          <SidebarLeft size={15} color="currentColor" />
        </button>
      </div>

      {/* Search */}
      <div style={{ padding: "10px 10px 6px", flexShrink: 0 }}>
        <div style={{
          display: "flex", alignItems: "center", gap: 7,
          background: "var(--surface-2)", border: "1px solid var(--border)",
          borderRadius: 8, padding: "6px 10px",
        }}>
          <SearchNormal1 size={12} color="var(--text-faint)" />
          <input
            value={search}
            onChange={e => onSearchChange(e.target.value)}
            placeholder="Search conversations…"
            style={{
              flex: 1, background: "none", border: "none", outline: "none",
              fontSize: 12, color: "var(--text)", fontFamily: "inherit", minWidth: 0,
            }}
          />
        </div>
      </div>

      {/* Conversation list */}
      <div
        className="rvl-noscroll"
        style={{ flex: 1, overflowY: "auto", padding: "4px 8px 12px" }}
      >
        {groups.length === 0 && (
          <div style={{
            padding: "32px 12px", textAlign: "center",
            fontSize: 12, color: "var(--text-faint)",
          }}>
            {conversations.length === 0 ? "No conversations yet" : "No results"}
          </div>
        )}

        {groups.map(group => (
          <div key={group.label}>
            <div style={{
              fontSize: 10, fontWeight: 700, letterSpacing: "0.08em",
              textTransform: "uppercase", color: "var(--text-faint)",
              padding: "12px 8px 5px",
            }}>
              {group.label}
            </div>

            {group.items.map(conv => {
              const isActive = conv.id === activeId;
              return (
                <ConvRow
                  key={conv.id}
                  conv={conv}
                  isActive={isActive}
                  onSelect={onSelect}
                  onDelete={onDelete}
                />
              );
            })}
          </div>
        ))}
      </div>
    </div>
  );
}

/* Extracted row to avoid inline-event closure issues */
function ConvRow({
  conv, isActive, onSelect, onDelete,
}: {
  conv: Conversation;
  isActive: boolean;
  onSelect: (id: string) => void;
  onDelete: (id: string) => void;
}) {
  const [hovered, setHovered] = React.useState(false);

  return (
    <div
      onClick={() => onSelect(conv.id)}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{
        display: "flex", alignItems: "center", gap: 10,
        padding: "9px 10px", borderRadius: 10, cursor: "pointer",
        background: isActive ? "var(--surface-active, var(--surface-2))" : hovered ? "var(--surface-hover, var(--surface-2))" : "transparent",
        boxShadow: isActive ? "0 1px 4px rgba(0,0,0,.04)" : "none",
        transition: "background .15s",
        userSelect: "none",
      }}
    >
      {/* Active indicator bar */}
      <div style={{
        width: 3, height: 28, borderRadius: 99, flexShrink: 0,
        background: isActive ? "var(--accent)" : hovered ? "var(--border)" : "transparent",
        transition: "background .15s",
      }} />

      {/* Text */}
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{
          fontSize: 13, fontWeight: isActive ? 600 : 400,
          color: "var(--text)", lineHeight: "1.35",
          overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
        }}>
          {conv.title}
        </div>
        <div style={{
          fontSize: 11, color: "var(--text-faint)", marginTop: 1,
          overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
        }}>
          {conv.machineId}
        </div>
      </div>

      {/* Delete button — visible on hover */}
      <button
        onClick={e => { e.stopPropagation(); onDelete(conv.id); }}
        style={{
          background: "none", border: "none", cursor: "pointer",
          padding: 6, borderRadius: 6,
          color: "var(--text-faint)",
          opacity: hovered ? 1 : 0,
          transform: hovered ? "translateX(0) scale(1)" : "translateX(4px) scale(.9)",
          transition: "opacity .15s, transform .15s",
          display: "flex",
        }}
      >
        <Trash size={13} color="currentColor" />
      </button>
    </div>
  );
}