import type { ReactNode } from "react";

// Login page gets its own layout so it doesn't render inside AppShell (no navbar/sidebar).
export default function LoginLayout({ children }: { children: ReactNode }) {
  return <>{children}</>;
}
