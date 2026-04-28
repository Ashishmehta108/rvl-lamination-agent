import "./globals.css";
import type { ReactNode } from "react";
import { ClientProviders } from "../components/ClientProviders";
import AppShell from "../components/AppShell";

export const metadata = {
  title: "RVL Lamination Agent",
  description: "Industrial monitoring + alerts + reports + chat"
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" data-theme="light" suppressHydrationWarning>
      <body>
        <ClientProviders>
          <AppShell>{children}</AppShell>
        </ClientProviders>
      </body>
    </html>
  );
}
