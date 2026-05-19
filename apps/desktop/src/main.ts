import { app, BrowserWindow, Tray, Menu, nativeImage, dialog } from "electron";
import { spawn, execSync } from "child_process";
import path from "path";
import { fileURLToPath } from "url";
import http from "http";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

let mainWindow: BrowserWindow | null = null;
let tray: Tray | null = null;
let isQuitting = false;

const isDev = !app.isPackaged;
// Always load the Vercel production URL — no local dev server needed
const FRONTEND_URL = process.env.ELECTRON_START_URL
  ?? process.env.VERCEL_FRONTEND_URL
  ?? "https://rvl-lamination-agent-web.vercel.app";


const ECOSYSTEM_PATH = isDev
  ? path.resolve(app.getAppPath(), "..", "..", "ecosystem.config.cjs")
  : path.resolve(process.resourcesPath, "ecosystem.config.cjs");

const ICON_PATH = path.join(app.getAppPath(), isDev ? "" : "..", "assets", "icon.png");

// ─── PM2 Service Management ────────────────────────────────────────

/**
 * Run a shell command and return stdout (trimmed). Returns empty string on error.
 */
function runShell(cmd: string): string {
  try {
    return execSync(cmd, { encoding: "utf-8", windowsHide: true, timeout: 30000 }).trim();
  } catch {
    return "";
  }
}

/**
 * Run a shell command asynchronously with a Promise.
 * Uses spawn with windowsHide:true so no CMD console window appears on Windows.
 */
function runShellAsync(cmd: string): Promise<string> {
  return new Promise((resolve) => {
    const child = spawn(cmd, [], {
      shell: true,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    child.stdout?.on("data", (d: Buffer) => { stdout += d.toString(); });
    child.on("close", () => resolve(stdout.trim()));
    child.on("error", () => resolve(""));
  });
}

/**
 * Check if PM2 is globally available.
 */
function isPm2Available(): boolean {
  const result = runShell("pm2 --version");
  return result.length > 0;
}

/**
 * Check if PM2 services are currently running.
 */
function areServicesRunning(): boolean {
  try {
    const jlist = runShell("pm2 jlist");
    if (!jlist) return false;
    const processes = JSON.parse(jlist);
    return Array.isArray(processes) && processes.some(
      (p: { name: string; pm2_env?: { status?: string } }) =>
        p.name.startsWith("rvl-") && p.pm2_env?.status === "online"
    );
  } catch {
    return false;
  }
}

/**
 * Start all background services via PM2. Skips if already running.
 */
async function startServices(): Promise<void> {
  if (!isPm2Available()) {
    console.error("[Desktop] PM2 is not installed globally. Run: npm install -g pm2");
    dialog.showErrorBox(
      "PM2 Not Found",
      "PM2 is required to manage background services.\n\nPlease run:\n  npm install -g pm2\n\nThen restart the app."
    );
    return;
  }

  if (areServicesRunning()) {
    console.log("[Desktop] PM2 services already running — skipping start.");
    return;
  }

  console.log("[Desktop] Starting background services via PM2...");
  const result = await runShellAsync(`pm2 start "${ECOSYSTEM_PATH}"`);
  console.log("[Desktop] PM2 start result:", result);

  // Save process list so `pm2 resurrect` can restore them after reboot
  await runShellAsync("pm2 save");
  console.log("[Desktop] PM2 process list saved.");
}

/**
 * Stop all RVL services managed by PM2.
 */
async function stopServices(): Promise<void> {
  console.log("[Desktop] Stopping PM2 services...");
  await runShellAsync("pm2 stop rvl-backend rvl-ngrok");
  console.log("[Desktop] PM2 services stopped.");
}

/**
 * Restart all RVL services managed by PM2.
 */
async function restartServices(): Promise<void> {
  console.log("[Desktop] Restarting PM2 services...");
  await runShellAsync(`pm2 restart "${ECOSYSTEM_PATH}"`);
  await runShellAsync("pm2 save");
  console.log("[Desktop] PM2 services restarted & saved.");
}

// ─── Tray ──────────────────────────────────────────────────────────

function createTray() {
  const icon = nativeImage.createFromPath(ICON_PATH);
  tray = new Tray(icon);

  const contextMenu = Menu.buildFromTemplate([
    { label: "Show App", click: () => mainWindow?.show() },
    { type: "separator" },
    {
      label: "Start Services",
      click: async () => {
        await startServices();
        dialog.showMessageBox({ message: "Background services started.", type: "info" });
      }
    },
    {
      label: "Stop Services",
      click: async () => {
        await stopServices();
        dialog.showMessageBox({ message: "Background services stopped.", type: "info" });
      }
    },
    {
      label: "Restart Services",
      click: async () => {
        await restartServices();
        dialog.showMessageBox({ message: "Background services restarted.", type: "info" });
      }
    },
    { type: "separator" },
    {
      label: "View Logs",
      click: () => {
        // Open a real visible terminal for log viewing
        spawn("cmd", ["/c", "start", "cmd", "/k", "pm2 logs --lines 100"], {
          shell: false,
          detached: true,
          stdio: "ignore",
        }).unref();
      }
    },
    {
      label: "Service Status",
      click: async () => {
        const status = runShell("pm2 status");
        dialog.showMessageBox({
          message: status || "No PM2 processes found.",
          type: "info",
          title: "Service Status"
        });
      }
    },
    { type: "separator" },
    {
      label: "Quit (services keep running)",
      click: () => {
        isQuitting = true;
        app.quit();
      }
    }
  ]);

  tray.setToolTip("RVL Lamination AI Agent");
  tray.setContextMenu(contextMenu);
  tray.on("double-click", () => mainWindow?.show());
}

// ─── Port Waiter ──────────────────────────────────────────────────

/**
 * Polls a localhost port until it responds, then resolves.
 */
function waitForPort(port: number, timeoutMs = 60000): Promise<void> {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + timeoutMs;
    const attempt = () => {
      const req = http.get(`http://127.0.0.1:${port}`, (res) => {
        res.destroy();
        resolve();
      });
      req.on("error", () => {
        if (Date.now() > deadline) {
          reject(new Error(`Timed out waiting for port ${port}`));
        } else {
          setTimeout(attempt, 1000);
        }
      });
      req.setTimeout(1000, () => req.destroy());
    };
    attempt();
  });
}

// ─── Window ────────────────────────────────────────────────────────

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    backgroundColor: "#0b0f14",
    title: "RVL Lamination AI Agent — Starting...",
    icon: ICON_PATH,
    webPreferences: {
      sandbox: true,
      contextIsolation: true
    }
  });

  // Show a simple loading page while services warm up
  mainWindow.loadURL("data:text/html,<html style='background:#0b0f14;display:flex;align-items:center;justify-content:center;height:100vh;margin:0'><p style='color:#a0aec0;font-family:sans-serif;font-size:18px'>Starting services, please wait...</p></html>");

  mainWindow.on("close", (event) => {
    if (!isQuitting) {
      event.preventDefault();
      mainWindow?.hide();
    }
  });
}

async function loadFrontend() {
  // Always load the Vercel production URL directly — no port polling needed
  mainWindow?.loadURL(FRONTEND_URL);
  mainWindow?.setTitle("RVL Lamination AI Agent");
}


// ─── Startup Registration ──────────────────────────────────────────

// Register Electron app to open at Windows login
app.setLoginItemSettings({
  openAtLogin: true,
  path: app.getPath("exe"),
});

// ─── App Lifecycle ─────────────────────────────────────────────────

app.whenReady().then(async () => {
  await startServices();
  createWindow();
  createTray();
  // Wait for port 3000 in background, then load the real URL
  loadFrontend();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
      loadFrontend();
    }
  });
});

// On quit: do NOT kill PM2 services — they should keep running in background
app.on("before-quit", () => {
  isQuitting = true;
  // Services intentionally left running via PM2
  console.log("[Desktop] Electron quitting. PM2 services continue running in background.");
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    // Don't quit — keep tray alive
  }
});
