import { spawn } from "node:child_process";
import process from "node:process";

// Dev supervisor: start backend + next + electron.
// In production, PM2 + packaged Electron will handle lifecycle.

const root = new URL("../../..", import.meta.url).pathname;

function run(cmd: string, args: string[], name: string) {
  const child = spawn(cmd, args, {
    cwd: root,
    stdio: "inherit",
    shell: true,
    env: { ...process.env, FORCE_COLOR: "1" }
  });
  child.on("exit", (code) => {
    if (code && code !== 0) process.exit(code);
  });
  return child;
}

run("npm", ["run", "dev", "-w", "apps/backend"], "backend");
run("npm", ["run", "dev", "-w", "apps/web"], "web");

setTimeout(() => {
  run("electron", ["-r", "tsx/cjs", "src/main.ts"], "electron");
}, 2500);

