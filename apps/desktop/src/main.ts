import { app, BrowserWindow } from "electron";

async function waitForHttp(url: string, timeoutMs: number) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      const res = await fetch(url, { method: "GET" });
      if (res.ok) return true;
    } catch {
      // ignore and retry
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  return false;
}

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
<<<<<<< HEAD
  console.log(`[Desktop] Loading URL: ${url}`);
  void win.loadURL(url);
=======
  void (async () => {
    const ok = await waitForHttp(url, 10_000);
    if (!ok) {
      await win.loadURL(
        "data:text/html," +
          encodeURIComponent(
            `<html><body style="background:#0b0f14;color:#d8dee9;font-family:system-ui;padding:24px">
              <h2>Desktop UI server not reachable</h2>
              <p>Tried: <code>${url}</code></p>
              <p>If you are in dev, run <code>npm run dev</code> at repo root, or <code>npm run dev -w apps/desktop</code>.</p>
            </body></html>`
          )
      );
      return;
    }
    await win.loadURL(url);
  })();
>>>>>>> aae9254029dd7933b24756c4a7082b29a682d2c9
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

