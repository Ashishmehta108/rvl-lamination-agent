"use client";

import { ReactNode } from "react";
import { SWRConfig } from "swr";
import { toast, Toaster } from "sonner";
import { ThemeProvider } from "../lib/theme";
import { AppProvider } from "../context/AppContext";

export function ClientProviders({ children }: { children: ReactNode }) {
  return (
    <ThemeProvider>
      <AppProvider>
        <SWRConfig
          value={{
            onError: (error, key) => {
              if (error.status !== 404) {
                toast.error(`Data sync error: ${key}`, {
                  description: error.message || "Please check your connection.",
                });
              }
            },
          }}
        >
          {children}
          <Toaster position="bottom-right" richColors expand={false} />
        </SWRConfig>
      </AppProvider>
    </ThemeProvider>
  );
}
