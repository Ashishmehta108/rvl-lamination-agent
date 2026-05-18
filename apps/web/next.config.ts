import type { NextConfig } from "next";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const nextConfig: NextConfig = {
  // outputFileTracingRoot silences the monorepo lockfile warning on Vercel/CI
  outputFileTracingRoot: path.join(__dirname, "../.."),
  async redirects() {
    return [{ source: "/assistant", destination: "/chat", permanent: false }];
  }
};

export default nextConfig;
