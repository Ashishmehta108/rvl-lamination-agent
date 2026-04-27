import { useState, useEffect, useCallback } from "react";
import { api } from "../lib/api";

const STORE_KEY = "rvl-conversations";

export type Role = "user" | "assistant";
export interface ToolStep {
  tool: string;
  label: string;
  durationMs: number;
}

export interface Message {
  role: Role;
  content: string;
  citations?: { index: number; chunkId: string; sourceUri: string | null }[];
  steps?: ToolStep[];
  grounded?: boolean;
  error?: boolean;
}

export interface Conversation {
  id: string;
  title: string;
  machineId: string;
  messages: Message[];
  createdAt: number;
  updatedAt: number;
}

export function useChat() {
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  // Init from storage
  useEffect(() => {
    try {
      const raw = localStorage.getItem(STORE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw);
        setConversations(parsed);
        if (parsed.length) setActiveId(parsed[0].id);
      }
    } catch (e) {
      console.error("Failed to load conversations", e);
    }
  }, []);

  // Sync to storage
  useEffect(() => {
    if (conversations.length) {
      localStorage.setItem(STORE_KEY, JSON.stringify(conversations));
    }
  }, [conversations]);

  const active = conversations.find(c => c.id === activeId) ?? null;

  const startNewChat = useCallback(() => {
    const id = Math.random().toString(36).slice(2) + Date.now().toString(36);
    const c: Conversation = {
      id,
      title: "New conversation",
      machineId: "lamination-01",
      messages: [],
      createdAt: Date.now(),
      updatedAt: Date.now()
    };
    setConversations(prev => [c, ...prev]);
    setActiveId(c.id);
    return id;
  }, []);

  const deleteConversation = (id: string) => {
    setConversations(prev => prev.filter(c => c.id !== id));
    if (activeId === id) {
      setActiveId(prev => conversations.find(c => c.id !== id)?.id ?? null);
    }
  };

  const updateMachineId = (id: string) => {
    setConversations(prev => prev.map(c => c.id === activeId ? { ...c, machineId: id } : c));
  };

  const sendMessage = async (text: string) => {
    if (!text.trim() || loading) return;

    let convId = activeId;
    if (!convId) {
      convId = startNewChat();
    }

    const userMsg: Message = { role: "user", content: text };
    
    // Update local state immediately
    setConversations(prev => {
      const updated = prev.map(c => {
        if (c.id !== convId) return c;
        return {
          ...c,
          messages: [...c.messages, userMsg],
          title: c.messages.length === 0 ? text.slice(0, 42) : c.title,
          updatedAt: Date.now()
        };
      });
      return updated;
    });

    setLoading(true);

    try {
      // Use the current state or a fallback
      const data = await api.post<{ answer: string; citations: any[]; grounded: boolean; steps?: ToolStep[] }>(`/chat`, {
        machineId: active?.machineId || "lamination-01",
        messages: [...(active?.messages || []), userMsg].filter(m => !m.error).map(m => ({ role: m.role, content: m.content }))
      });

      const assistantMsg: Message = {
        role: "assistant",
        content: data.answer,
        citations: data.citations,
        steps: data.steps,
        grounded: data.grounded
      };

      setConversations(prev => prev.map(c => 
        c.id === convId ? { ...c, messages: [...c.messages, assistantMsg], updatedAt: Date.now() } : c
      ));
    } catch (e: any) {
      const errorMsg: Message = {
        role: "assistant",
        content: `⚠ ${e.message}`,
        error: true
      };
      setConversations(prev => prev.map(c => 
        c.id === convId ? { ...c, messages: [...c.messages, errorMsg], updatedAt: Date.now() } : c
      ));
    } finally {
      setLoading(false);
    }
  };

  return {
    conversations,
    active,
    activeId,
    setActiveId,
    loading,
    startNewChat,
    deleteConversation,
    updateMachineId,
    sendMessage
  };
}
