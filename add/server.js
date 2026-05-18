
//server.js
const http = require("http");
const fs = require("fs");
const path = require("path");
const ModbusRTU = require("modbus-serial");

// ── CONFIG ───────────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const CONFIG = {
    host: args[0] || "192.168.1.17",
    port: parseInt(args[1]) || 502,
    slaveId: parseInt(args[2]) || 1,
    webPort: 4444,
    pollInterval: 1000,
    // ingestUrl: process.env.INGEST_URL || "http://127.0.0.1:7000/ingest/tags",
    ingestUrl: "https://sherril-exoskeletal-heinously.ngrok-free.dev/ingest/tags",
    machineId: process.env.MACHINE_ID || "lamination-01",
    machineRevision: process.env.MACHINE_REVISION || "v1",
    authToken: process.env.API_AUTH_TOKEN || "dev-local-token"
};

const TAGS = {
    // EXTRUDER
    EXTRUDER_RPM: { addr: 401104, type: "float", fc: 3 },
    EXTRUDER_AMP: { addr: 401108, type: "float", fc: 3 },
    EXTRUDER_SPEED_PCT: { addr: 400001, type: "uint16", fc: 3 },
    EXTRUDER_ON_OFF: { addr: 100, type: "bool", fc: 1 },
    EXTRUDER_FAULT: { addr: 12, type: "bool", fc: 1 },
    EXTRUDER_SPEED_VOL: { addr: 401200, type: "float", fc: 3 },
    // LAMINATOR
    LAMINATOR_MPM: { addr: 401106, type: "float", fc: 3 },
    LAMINATOR_AMP: { addr: 401110, type: "float", fc: 3 },
    LAMINATOR_SPEED_PCT: { addr: 400002, type: "uint16", fc: 3 },
    LAMINATOR_ON_OFF: { addr: 101, type: "bool", fc: 1 },
    LAMINATOR_FAULT: { addr: 13, type: "bool", fc: 1 },
    LAMINATOR_SPEED_VOL: { addr: 401202, type: "float", fc: 3 },
    // WINDER
    WINDER_AMP: { addr: 401112, type: "float", fc: 3 },
    WINDER_TENSION_PCT: { addr: 400003, type: "uint16", fc: 3 },
    WINDER_ON_OFF: { addr: 102, type: "bool", fc: 1 },
    WINDER_FAULT: { addr: 14, type: "bool", fc: 1 },
    WINDER_TENSION_VOL: { addr: 401040, type: "float", fc: 3 },
    // MASTER
    MASTER_SPEED_PCT: { addr: 400000, type: "uint16", fc: 3 },
    // UNWINDER
    UW_SET_TENSION: { addr: 403502, type: "uint16", fc: 3 },
    UW_PV_TENSION: { addr: 403880, type: "uint16", fc: 3 },
    // METERS
    RUNNING_METER: { addr: 400008, type: "float", fc: 3 },
    TOTAL_METER: { addr: 400010, type: "float", fc: 3 },
    // GSM
    GSM_ENTRY: { addr: 401300, type: "float", fc: 3 },
    GRAM_ENTRY: { addr: 403004, type: "float", fc: 3 },
    // ALARMS
    ALARM_IND: { addr: 125, type: "bool", fc: 1 },
    EMG_STOP: { addr: 9, type: "bool", fc: 1 },
    // SPLICE
    SPLICE_ON_OFF: { addr: 111, type: "bool", fc: 1 },
    SPLICE_SPEED: { addr: 400018, type: "uint16", fc: 3 },
};

// ── RUNTIME STATE ────────────────────────────────────────────────────────────
let state = {
    connected: false,
    error: null,
    readCount: 0,
    tags: {},
    ts: null,
    lastPush: { success: null, error: null, ts: null }
};

// Initialize tag values
for (const key in TAGS) state.tags[key] = null;

// ── MODBUS BACKEND ───────────────────────────────────────────────────────────
const client = new ModbusRTU();

async function connect() {
    try {
        await client.connectTCP(CONFIG.host, { port: CONFIG.port });
        client.setID(CONFIG.slaveId);
        client.setTimeout(2000);
        state.connected = true;
        state.error = null;
        console.log(`✅ Connected to Modbus at ${CONFIG.host}:${CONFIG.port}`);
    } catch (e) {
        state.connected = false;
        state.error = e.message;
        console.error(`❌ Connection error: ${e.message}`);
    }
}

function cdabToFloat(hi, lo) {
    const buf = Buffer.alloc(4);
    buf.writeUInt16BE(lo, 0);
    buf.writeUInt16BE(hi, 2);
    return buf.readFloatBE(0);
}

function getReg(addr) {
    return addr >= 400000 ? addr - 400000 : addr;
}

async function pushToBackend(tags) {
    const tagsPayload = Object.entries(tags).map(([slug, val]) => ({
        tagId: slug,
        tagSlug: slug,
        value: val,
        ts: new Date().toISOString()
    }));

    const payload = {
        machineId: CONFIG.machineId,
        machineRevision: CONFIG.machineRevision,
        sentAt: new Date().toISOString(),
        seq: Date.now(),
        tags: tagsPayload
    };

    const res = await fetch(CONFIG.ingestUrl, {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            "Authorization": `Bearer ${CONFIG.authToken}`,
            "x-machine-id": CONFIG.machineId,
            "x-machine-revision": CONFIG.machineRevision
        },
        body: JSON.stringify(payload)
    });

    state.lastPush.ts = new Date().toISOString();
    if (!res.ok) {
        const errText = await res.text();
        state.lastPush.success = false;
        state.lastPush.error = `${res.status} ${errText}`;
        console.error(`❌ Push failed: ${state.lastPush.error}`);
    } else {
        state.lastPush.success = true;
        state.lastPush.error = null;
        console.log(`✅ Data pushed to backend: ${state.lastPush.ts}`);
    }
}


async function poll() {
    if (!state.connected) {
        await connect();
        setTimeout(poll, 5000);
        return;
    }

    try {
        state.readCount++;
        state.ts = new Date().toISOString();

        for (const [name, tag] of Object.entries(TAGS)) {
            const reg = getReg(tag.addr);
            if (tag.fc === 1) {
                const res = await client.readCoils(reg, 1);
                state.tags[name] = res.data[0] ? 1 : 0;
            } else if (tag.type === "float") {
                const res = await client.readHoldingRegisters(reg, 2);
                state.tags[name] = cdabToFloat(res.data[0], res.data[1]);
            } else {
                const res = await client.readHoldingRegisters(reg, 1);
                state.tags[name] = res.data[0];
            }
        }
        state.error = null;
        // Push to backend after successful poll
        pushToBackend(state.tags);
    } catch (e) {
        state.error = e.message;
        state.connected = false;
        client.close();
    }
    setTimeout(poll, CONFIG.pollInterval);
}

// ── WEB SERVER ───────────────────────────────────────────────────────────────
const server = http.createServer((req, res) => {
    const url = req.url === "/" ? "/index.html" : req.url;

    if (url === "/api/data") {
        res.writeHead(200, { "Content-Type": "application/json" });
        return res.end(JSON.stringify(state));
    }

    // Serve static files
    const filePath = path.join(__dirname, url);
    fs.readFile(filePath, (err, data) => {
        if (err) {
            res.writeHead(404);
            return res.end("Not found");
        }
        const ext = path.extname(url);
        const contentType = {
            ".html": "text/html",
            ".css": "text/css",
            ".js": "application/javascript"
        }[ext] || "text/plain";

        res.writeHead(200, { "Content-Type": contentType });
        res.end(data);
    });
});

server.listen(CONFIG.webPort, () => {
    console.log(`🚀 Dashboard running at http://localhost:${CONFIG.webPort}`);
    poll();
});