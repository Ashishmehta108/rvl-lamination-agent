"use client";

import React, { createContext, useContext, useState, useCallback } from "react";
import { api } from "../lib/api";
import { toast } from "sonner";

interface AppContextType {
  machineId: string;
  setMachineId: (id: string) => void;
  isGeneratingReport: boolean;
  triggerReport: () => Promise<void>;
  menuOpen: boolean;
  setMenuOpen: (open: boolean) => void;
}

const AppContext = createContext<AppContextType | undefined>(undefined);

export function AppProvider({ children }: { children: React.ReactNode }) {
  const [machineId, setMachineId] = useState("lamination-01");
  const [isGeneratingReport, setIsGeneratingReport] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);

  const triggerReport = useCallback(async () => {
    setIsGeneratingReport(true);
    const id = toast.loading("Generating production report...");
    try {
      await api.post("/reports/trigger", { machineId });
      toast.success("Report generation started", { id, description: "You will receive an email once it is ready." });
    } catch (err: any) {
      console.error("Failed to trigger report", err);
      toast.error("Failed to generate report", { id, description: err.message || "An unexpected error occurred." });
    } finally {
      setIsGeneratingReport(false);
    }
  }, [machineId]);

  return (
    <AppContext.Provider value={{ 
      machineId, setMachineId, 
      isGeneratingReport, triggerReport,
      menuOpen, setMenuOpen 
    }}>
      {children}
    </AppContext.Provider>
  );
}

export function useAppContext() {
  const context = useContext(AppContext);
  if (!context) throw new Error("useAppContext must be used within AppProvider");
  return context;
}
