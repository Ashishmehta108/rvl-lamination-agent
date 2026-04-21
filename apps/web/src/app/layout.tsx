import "./globals.css";
import type { ReactNode } from "react";

export const metadata = {
  title: "RVL Lamination Agent",
  description: "Industrial monitoring + alerts + reports + chat"
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}

