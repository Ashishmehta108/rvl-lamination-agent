import { app, BrowserWindow } from "electron";

function createWindow() {
  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    backgroundColor: "#0b0f14",
    webPreferences: {
      sandbox: true,
      contextIsolation: true
    }
  });

  const url = process.env.ELECTRON_START_URL ?? "http://127.0.0.1:3000";
  void win.loadURL(url);
}

app.whenReady().then(() => {
  createWindow();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

