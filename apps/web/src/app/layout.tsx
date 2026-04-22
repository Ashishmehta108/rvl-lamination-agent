import "./globals.css";
import type { ReactNode } from "react";
import { ThemeProvider } from "../lib/theme";

export const metadata = {
  title: "RVL Lamination Agent",
  description: "Industrial monitoring + alerts + reports + chat"
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" data-theme="light" suppressHydrationWarning>
      <body>
        <ThemeProvider>{children}</ThemeProvider>
      </body>
    </html>
  );
}
