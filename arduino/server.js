const express = require("express");
const path = require("path");
const fs = require("fs");
const archiver = require("archiver");

const app = express();
const PORT = 3000;

// ── Raspberry Pi script folder ───────────────────────────────
const RPI_DIR = path.join(__dirname, "..", "raspberry_pi");
const FILES = ["data_source.py", "requirements.txt", ".env.example"];

// ── Remote Backend (ngrok) ───────────────────────────────────
const REMOTE_URL = "https://mace-ebony-capital.ngrok-free.dev";
const API_AUTH_TOKEN = process.env.API_AUTH_TOKEN || "dev-local-token";
const MACHINE_ID = process.env.MACHINE_ID || "lamination-01";
const MACHINE_REVISION = process.env.MACHINE_REVISION || "v1";

let ingestSeq = 0;

app.use(express.json());

// ── GET / — list available files ────────────────────────────
app.get("/", (req, res) => {
  const fileList = FILES.map((f) => {
    const fp = path.join(RPI_DIR, f);
    const exists = fs.existsSync(fp);
    const stats = exists ? fs.statSync(fp) : null;
    return {
      filename: f,
      exists,
      size: stats ? stats.size : null,
      modified: stats ? stats.mtime.toISOString() : null,
      download: `/download/${f}`,
      view: `/view/${f}`,
    };
  });

  res.json({
    service: "raspberry-pi-file-server",
    directory: "raspberry_pi/",
    downloadAll: "/download",
    files: fileList,
  });
});

// ── GET /download — download entire raspberry_pi/ as .zip ───
app.get("/download", (req, res) => {
  if (!fs.existsSync(RPI_DIR)) {
    return res.status(404).json({ error: "raspberry_pi/ directory not found" });
  }

  res.setHeader("Content-Type", "application/zip");
  res.setHeader("Content-Disposition", 'attachment; filename="raspberry_pi.zip"');

  const archive = archiver("zip", { zlib: { level: 9 } });
  archive.on("error", (err) => {
    console.error("[Download] Archive error:", err.message);
    res.status(500).end();
  });
  archive.pipe(res);

  for (const f of FILES) {
    const fp = path.join(RPI_DIR, f);
    if (fs.existsSync(fp)) {
      archive.file(fp, { name: f });
    }
  }

  archive.finalize();
});

// ── GET /download/:filename — download a single file ────────
app.get("/download/:filename", (req, res) => {
  const filename = req.params.filename;
  if (!FILES.includes(filename)) {
    return res.status(404).json({ error: `Unknown file: ${filename}` });
  }

  const fp = path.join(RPI_DIR, filename);
  if (!fs.existsSync(fp)) {
    return res.status(404).json({ error: `${filename} not found` });
  }

  res.download(fp, filename);
});

// ── GET /view/:filename — view raw file content ─────────────
app.get("/view/:filename", (req, res) => {
  const filename = req.params.filename;
  if (!FILES.includes(filename)) {
    return res.status(404).json({ error: `Unknown file: ${filename}` });
  }

  const fp = path.join(RPI_DIR, filename);
  if (!fs.existsSync(fp)) {
    return res.status(404).json({ error: `${filename} not found` });
  }

  const content = fs.readFileSync(fp, "utf-8");
  res.type("text/plain").send(content);
});

// ── GET /json — all files content + metadata as JSON ────────
app.get("/json", (req, res) => {
  const result = {};
  for (const f of FILES) {
    const fp = path.join(RPI_DIR, f);
    if (fs.existsSync(fp)) {
      const stats = fs.statSync(fp);
      result[f] = {
        filename: f,
        size: stats.size,
        modified: stats.mtime.toISOString(),
        content: fs.readFileSync(fp, "utf-8"),
      };
    } else {
      result[f] = { filename: f, exists: false };
    }
  }
  res.json(result);
});

// ── POST /ingest — receive sensor data from RPi and forward to backend ──
// The Raspberry Pi 4B collects data from Arduino and POSTs here.
// This server transforms it into the IngestBatch schema and forwards
// to the remote backend at the ngrok URL.
//
// Expected body from RPi:
// {
//   "tags": {
//     "EXTRUDER_RPM": 62.5,
//     "EXTRUDER_AMP": 21.3,
//     "LAMINATOR_MPM": 104.2,
//     ...
//   }
// }
app.post("/ingest", async (req, res) => {
  try {
    const rawTags = req.body.tags || req.body;

    // Transform into IngestBatch format matching the backend schema:
    // { machineId, machineRevision, sentAt, seq, tags: [{ tagSlug, value, ts }] }
    const now = new Date();
    const tags = [];

    for (const [key, val] of Object.entries(rawTags)) {
      // Handle both { EXTRUDER_RPM: 62.5 } and { EXTRUDER_RPM: { value: 62.5 } }
      const value = typeof val === "object" && val !== null && "value" in val
        ? val.value
        : val;

      tags.push({
        tagSlug: key,
        value: value,
        ts: now.toISOString(),
      });
    }

    if (tags.length === 0) {
      return res.status(400).json({ error: "no_tags_provided" });
    }

    const payload = {
      machineId: MACHINE_ID,
      machineRevision: MACHINE_REVISION,
      sentAt: now.toISOString(),
      seq: ingestSeq++,
      tags,
    };

    console.log(`[Ingest] Forwarding ${tags.length} tags (seq=${payload.seq}) to ${REMOTE_URL}/ingest/tags`);

    const response = await fetch(`${REMOTE_URL}/ingest/tags`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${API_AUTH_TOKEN}`,
      },
      body: JSON.stringify(payload),
    });

    const result = await response.json();

    if (!response.ok) {
      console.error(`[Ingest] Backend returned ${response.status}:`, result);
      return res.status(response.status).json({ error: "backend_error", detail: result });
    }

    console.log(`[Ingest] ✓ Accepted: ${result.accepted}, Rejected: ${result.rejected}`);
    return res.json({ ok: true, forwarded: tags.length, backend: result });
  } catch (err) {
    console.error("[Ingest Error]", err.message);
    return res.status(500).json({ error: "forward_failed", message: err.message });
  }
});

// ── GET /health — server health check ───────────────────────
app.get("/health", (req, res) => {
  res.json({
    ok: true,
    service: "raspberry-pi-file-server",
    remoteUrl: REMOTE_URL,
    machineId: MACHINE_ID,
    ingestSeq,
    time: new Date().toISOString(),
  });
});

app.listen(PORT, "0.0.0.0", () => {
  console.log("============================================");
  console.log("  Raspberry Pi File & Ingest Server");
  console.log("============================================");
  console.log(`  Port:       http://0.0.0.0:${PORT}`);
  console.log(`  Remote:     ${REMOTE_URL}`);
  console.log(`  Machine:    ${MACHINE_ID} (${MACHINE_REVISION})`);
  console.log(`  Serves:     raspberry_pi/ directory`);
  console.log("");
  console.log("  GET  /                  → list all files");
  console.log("  GET  /download          → download all as .zip");
  console.log("  GET  /download/:file    → download single file");
  console.log("  GET  /view/:file        → view raw file content");
  console.log("  GET  /json              → JSON with all files + metadata");
  console.log("  POST /ingest            → forward sensor data to backend");
  console.log("  GET  /health            → server status");
  console.log("============================================");
});
