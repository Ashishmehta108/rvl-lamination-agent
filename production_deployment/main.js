import { app, BrowserWindow, Tray, Menu, nativeImage } from 'electron';
import { spawn } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

let mainWindow;
let tray;
let backendProcess;
let isQuitting = false;

// Configuration
const BACKEND_PATH = path.join(__dirname, '..', 'apps', 'backend', 'dist', 'index.js');
const RESTART_DELAY = 2000; // 2 seconds

/**
 * Spawns the Node.js backend process with auto-restart logic
 */
function startBackend() {
  console.log('[Electron] Starting backend process...');
  
  backendProcess = spawn('node', [BACKEND_PATH], {
    stdio: 'inherit',
    env: { ...process.env, NODE_ENV: 'production', PORT: 7000 }
  });

  backendProcess.on('exit', (code) => {
    if (!isQuitting) {
      console.error(`[Electron] Backend crashed with code ${code}. Restarting in ${RESTART_DELAY/1000}s...`);
      setTimeout(startBackend, RESTART_DELAY);
    }
  });

  backendProcess.on('error', (err) => {
    console.error('[Electron] Failed to start backend:', err);
  });
}

/**
 * Creates the System Tray icon and menu
 */
function createTray() {
  // Use a placeholder or a simple icon if available
  const iconPath = path.join(__dirname, 'assets', 'icon.png'); // Ensure you have an icon
  const icon = nativeImage.createEmpty(); // Fallback to empty if no icon
  
  tray = new Tray(icon);
  const contextMenu = Menu.buildFromTemplate([
    { label: 'Show App', click: () => mainWindow.show() },
    { type: 'separator' },
    { label: 'Quit', click: () => {
      isQuitting = true;
      app.quit();
    }}
  ]);

  tray.setToolTip('Lamination AI Agent');
  tray.setContextMenu(contextMenu);

  tray.on('double-click', () => {
    mainWindow.show();
  });
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
    },
    // icon: path.join(__dirname, 'assets/icon.png')
  });

  // Load the Next.js frontend (assuming it's running on port 3000)
  mainWindow.loadURL('http://localhost:3000');

  // Intercept close event to hide to tray
  mainWindow.on('close', (event) => {
    if (!isQuitting) {
      event.preventDefault();
      mainWindow.hide();
    }
  });
}

// Handle Auto-start on Windows boot
app.setLoginItemSettings({
  openAtLogin: true,
  path: app.getPath('exe'),
});

app.whenReady().then(() => {
  startBackend();
  createWindow();
  createTray();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

// Clean up backend on quit
app.on('before-quit', () => {
  isQuitting = true;
  if (backendProcess) {
    backendProcess.kill();
  }
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    // Keep app running in tray as requested
  }
});
