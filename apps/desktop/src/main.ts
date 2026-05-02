import { app, BrowserWindow, Tray, Menu, nativeImage } from "electron";
import { spawn, ChildProcess } from "child_process";
import path from "path";
import { fileURLToPath } from "url";

// Get __dirname for ESM
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

let mainWindow: BrowserWindow | null = null;
let tray: Tray | null = null;
let backendProcess: ChildProcess | null = null;
let tunnelFrontProcess: ChildProcess | null = null;
let tunnelBackProcess: ChildProcess | null = null;
let isQuitting = false;

// Configuration
const isDev = !app.isPackaged;
const RESTART_DELAY = 2000;
const BACKEND_PORT = 7000;
const FRONTEND_PORT = 3000;
const FRONTEND_URL = process.env.ELECTRON_START_URL ?? `http://localhost:${FRONTEND_PORT}`;
const LT_SUBDOMAIN = "lamination-ai-agent";

// Path to backend
const BACKEND_PATH = isDev 
  ? path.join(app.getAppPath(), "..", "backend", "dist", "index.js")
  : path.join(process.resourcesPath, "backend", "index.js");

/**
 * Spawns a background process with auto-restart
 */
function spawnManagedProcess(name: string, command: string, args: string[], port?: number) {
  console.log(`[Desktop] Starting ${name}...`);
  
  const child = spawn(command, args, {
    shell: true, // Required for Windows commands
    stdio: 'inherit',
    env: { ...process.env, NODE_ENV: 'production', PORT: port?.toString() || "" }
  });

  child.on('exit', (code) => {
    if (!isQuitting) {
      console.error(`[Desktop] ${name} exited with code ${code}. Restarting in ${RESTART_DELAY/1000}s...`);
      setTimeout(() => spawnManagedProcess(name, command, args, port), RESTART_DELAY);
    }
  });

  return child;
}

function startServices() {
  // 1. Start Backend
  backendProcess = spawnManagedProcess('Backend', 'node', [BACKEND_PATH], BACKEND_PORT);

  // 2. Start Tunnels (Only in production or if requested)
  if (!isDev) {
    tunnelFrontProcess = spawnManagedProcess('Localtunnel', 'npx', ['lt', '--port', FRONTEND_PORT.toString(), '--subdomain', LT_SUBDOMAIN]);
    tunnelBackProcess = spawnManagedProcess('Ngrok', 'npx', ['ngrok', 'http', BACKEND_PORT.toString()]);
  }
}

// Path to icon
const ICON_PATH = path.join(app.getAppPath(), isDev ? "" : "..", "assets", "icon.png");

function createTray() {
  const icon = nativeImage.createFromPath(ICON_PATH);
  tray = new Tray(icon);
  const contextMenu = Menu.buildFromTemplate([
    { label: 'Show App', click: () => mainWindow?.show() },
    { type: 'separator' },
    { label: 'Quit', click: () => {
      isQuitting = true;
      app.quit();
    }}
  ]);

  tray.setToolTip('RVL Lamination AI Agent');
  tray.setContextMenu(contextMenu);
  tray.on('double-click', () => mainWindow?.show());
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    backgroundColor: "#0b0f14",
    icon: ICON_PATH,
    webPreferences: {
      sandbox: true,
      contextIsolation: true
    }
  });

  mainWindow.loadURL(FRONTEND_URL);

  mainWindow.on('close', (event) => {
    if (!isQuitting) {
      event.preventDefault();
      mainWindow?.hide();
    }
  });
}

// Handle Auto-start on Windows boot
app.setLoginItemSettings({
  openAtLogin: true,
  path: app.getPath('exe'),
});

app.whenReady().then(() => {
  startServices();
  createWindow();
  createTray();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("before-quit", () => {
  isQuitting = true;
  if (backendProcess) backendProcess.kill();
  if (tunnelFrontProcess) tunnelFrontProcess.kill();
  if (tunnelBackProcess) tunnelBackProcess.kill();
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    // Keep app running in tray
  }
});

