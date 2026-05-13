'use strict';

const ModbusRTU = require('modbus-serial');
const logger = require('./logger');
const env = require('./env');
const { TAGS } = require('./tags');
const { state, applySnapshot } = require('./stateManager');

// ── Register address helpers ─────────────────────────────────────────────────
// Modbus addresses in TAGS use IEC 6-digit notation:
//   4xxxxx → holding registers  → offset = addr - 400001
//   1xx    → coils              → offset = addr - 1
// Modbus addresses in TAGS use IEC 6-digit notation for holding registers (4xxxxx).
// Logic copied from add/server.js:
function getReg(addr) {
    return addr >= 400000 ? addr - 400000 : addr;
}

// ── CDAB float conversion (matches Python cdabToFloat) ──────────────────────
// PLC sends floats as CDAB byte order: two 16-bit words where
// the high word comes first from the PLC but maps to bytes [2..3] of IEEE 754.
function cdabToFloat(hi, lo) {
    // hi = first register (res.data[0]), lo = second register (res.data[1])
    // Logic from add/server.js swaps the words into a buffer: [lo, hi]
    const buf = Buffer.alloc(4);
    buf.writeUInt16BE(lo, 0); // bytes 0-1 = low word (second register)
    buf.writeUInt16BE(hi, 2); // bytes 2-3 = high word (first register)
    return buf.readFloatBE(0);
}

// ── Snapshot validation ──────────────────────────────────────────────────────
function isLiveSnapshot(values) {
    const tagCount = Object.keys(values).length;
    if (tagCount < env.MIN_SUCCESS_TAGS) {
        return { ok: false, reason: `only ${tagCount} tags read (< MIN_SUCCESS_TAGS=${env.MIN_SUCCESS_TAGS})` };
    }
    for (const tag of env.REQUIRED_LIVE_TAGS) {
        if (!(tag in values)) {
            return { ok: false, reason: `missing required tag: ${tag}` };
        }
    }
    const coreNumeric = ['EXTRUDER_RPM', 'LAMINATOR_MPM', 'EXTRUDER_SPEED_PCT'];
    for (const tag of coreNumeric) {
        if (tag in values) {
            const v = values[tag];
            if (typeof v !== 'number' || !isFinite(v)) {
                return { ok: false, reason: `invalid numeric for ${tag}: ${v}` };
            }
        }
    }
    return { ok: true, reason: 'ok' };
}

// ── Read a single tag via the appropriate FC ─────────────────────────────────
async function readTag(client, name, tag) {
    if (tag.fc === 1) {
        // Coil
        const reg = getReg(tag.addr);
        const res = await client.readCoils(reg, 1);
        return res.data[0] ? 1 : 0;

    } else if (tag.fc === 3) {
        if (tag.type === 'float') {
            const reg = getReg(tag.addr);
            const res = await client.readHoldingRegisters(reg, 2);
            return cdabToFloat(res.data[0], res.data[1]);
        } else {
            // uint16
            const reg = getReg(tag.addr);
            const res = await client.readHoldingRegisters(reg, 1);
            return res.data[0];
        }
    } else {
        throw new Error(`Unsupported FC ${tag.fc} for tag ${name}`);
    }
}

// ── Poll all tags → { values, errors } ───────────────────────────────────────
async function pollSnapshot(client) {
    const values = {};
    const errors = [];
    for (const [name, tag] of Object.entries(TAGS)) {
        try {
            values[name] = await readTag(client, name, tag);
        } catch (err) {
            errors.push(`${name}: ${err.message}`);
        }
    }
    return { values, errors };
}

// ── Main poll loop ────────────────────────────────────────────────────────────
async function modbusPollLoop(stopSignal) {
    let failures = 0;

    logger.info(`[Loop] Modbus poll  — target ${env.PLC_HOST}:${env.PLC_PORT}  unit=${env.PLC_UNIT_ID}  interval=${env.UPDATE_INTERVAL}ms`);

    while (!stopSignal.stopped) {
        const client = new ModbusRTU();
        let connected = false;
        try {
            await client.connectTCP(env.PLC_HOST, { port: env.PLC_PORT });
            client.setID(env.PLC_UNIT_ID);
            client.setTimeout(env.MODBUS_TIMEOUT);
            connected = true;

            const { values, errors } = await pollSnapshot(client);
            const { ok, reason } = isLiveSnapshot(values);

            if (!ok) throw new Error(`snapshot_not_live (${reason})`);

            applySnapshot(values);
            state.plcHasLiveData = true;

            if (!state.plcOnline) logger.info(`[Poll] OK   PLC online  (${env.PLC_HOST}:${env.PLC_PORT})`);
            state.plcOnline = true;
            state.plcError = null;

            if (errors.length > 0) {
                logger.warn(`[Poll] Partial read — ${errors.length} tag(s) failed; sample: ${errors[0]}`);
            }

            failures = 0;

            const jitter = Math.random() * env.POLL_JITTER_MAX;
            await sleep(Math.max(0, env.UPDATE_INTERVAL + jitter));

        } catch (err) {
            if (state.plcOnline) logger.warn(`[Poll] DOWN PLC went offline: ${String(err.message).slice(0, 120)}`);
            state.plcOnline = false;
            state.plcError = err.message;
            state.connected = false;
            failures++;
            const backoff = Math.min(env.POLL_BACKOFF_MAX, env.POLL_BACKOFF_BASE * Math.pow(2, failures - 1));
            const jitter = Math.random() * env.POLL_JITTER_MAX;
            logger.warn(`[Poll] Failed #${failures} — retry in ${Math.round(backoff + jitter)}ms`);
            await sleep(backoff + jitter);
        } finally {
            if (connected) {
                try { client.close(); } catch (_) { }
            }
        }
    }
}

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

module.exports = { modbusPollLoop };