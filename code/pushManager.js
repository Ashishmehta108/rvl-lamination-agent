'use strict';

const axios = require('axios');
const logger = require('./logger');
const env = require('./env');
const { state } = require('./stateManager');
const { WALEntry, walPending, pruneSent } = require('./walManager');
const { checkHealth } = require('./healthCheck');
const { currentSignature } = require('./signature');

const INGEST_URL = env.REMOTE_BASE_URL.replace(/\/$/, '') + env.INGEST_PATH;

const _http = axios.create({
    baseURL: INGEST_URL,
    timeout: env.HTTP_TIMEOUT,
    headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${env.API_AUTH_TOKEN}`,
        'User-Agent': `NonwovenAgent/${env.MACHINE_REVISION}`,
        'x-machine-id': env.MACHINE_ID,
        'x-machine-revision': env.MACHINE_REVISION,
    },
});

let _lastQueuedSignature = null;

/**
 * Build the IngestBatch payload from current runtime state.
 */
function buildPayload() {
    const now = new Date().toISOString();
    const seq = state.ingestSeq++;
    const tags = [
        { tagSlug: 'EXTRUDER_RPM', value: +state.extruderRpm.toFixed(2), ts: now },
        { tagSlug: 'EXTRUDER_AMP', value: +state.extruderAmp.toFixed(2), ts: now },
        { tagSlug: 'EXTRUDER_SPEED_PCT', value: state.extruderPct, ts: now },
        { tagSlug: 'LAMINATOR_MPM', value: +state.laminatorMpm.toFixed(2), ts: now },
        { tagSlug: 'LAMINATOR_AMP', value: +state.laminatorAmp.toFixed(2), ts: now },
        { tagSlug: 'LAMINATOR_SPEED_PCT', value: state.laminatorPct, ts: now },
        { tagSlug: 'WINDER_AMP', value: +state.winderAmp.toFixed(2), ts: now },
        { tagSlug: 'WINDER_TENSION_PCT', value: state.winderTenPct, ts: now },
        { tagSlug: 'RUNNING_METER', value: +state.runningMeter.toFixed(1), ts: now },
        { tagSlug: 'TOTAL_METER', value: +state.totalMeter.toFixed(1), ts: now },
        { tagSlug: 'GSM_ENTRY', value: +state.gsm.toFixed(2), ts: now },
        { tagSlug: 'GRAM_ENTRY', value: +state.gram.toFixed(2), ts: now },
        { tagSlug: 'UW_SET_TENSION', value: state.uwSetTension, ts: now },
        { tagSlug: 'UW_PV_TENSION', value: state.uwPvTension, ts: now },
        { tagSlug: 'EXTRUDER_SPEED_VOL', value: +state.extSpeedVol.toFixed(2), ts: now },
        { tagSlug: 'LAMINATOR_SPEED_VOL', value: +state.lamSpeedVol.toFixed(2), ts: now },
        { tagSlug: 'WINDER_TENSION_VOL', value: +state.winderTenVol.toFixed(2), ts: now },
        { tagSlug: 'MASTER_SPEED_PCT', value: state.extruderPct, ts: now },
        { tagSlug: 'EMG_STOP', value: state.emgStop, ts: now },
        { tagSlug: 'EXTRUDER_ON_OFF', value: true, ts: now },
        { tagSlug: 'LAMINATOR_ON_OFF', value: true, ts: now },
        { tagSlug: 'WINDER_ON_OFF', value: true, ts: now },
    ];
    return {
        machineId: env.MACHINE_ID,
        machineRevision: env.MACHINE_REVISION,
        sentAt: now,
        seq,
        tags,
    };
}

/**
 * POST a single WAL entry to the backend.
 * Returns true on HTTP 200/201, false on any failure.
 */
async function pushOne(entry) {
    const data = entry.load();
    const payload = data.payload;
    try {
        const res = await _http.post('', payload, {
            headers: { 'X-Batch-ID': data.batch_id },
        });
        if (res.status === 200 || res.status === 201) {
            logger.info(
                `[Push] OK    seq=${String(payload.seq).padEnd(6)}  batch=${data.batch_id.slice(0, 8)}  tags=${payload.tags.length}`
            );
            entry.markSent();
            state.lastPush = { success: true, error: null, ts: new Date().toISOString() };
            return true;
        }
        const err = `HTTP ${res.status}: ${String(res.data).slice(0, 120)}`;
        logger.warn(`[Push] FAIL  seq=${payload.seq}  ${err}`);
        entry.incrementRetry(err);
        if (entry.retryCount >= env.MAX_RETRIES) entry.markDead();
        state.lastPush = { success: false, error: err, ts: new Date().toISOString() };
        return false;
    } catch (err) {
        const msg = String(err.message).slice(0, 120);
        logger.warn(`[Push] FAIL  seq=${payload.seq}  ${msg}`);
        entry.incrementRetry(msg);
        if (entry.retryCount >= env.MAX_RETRIES) entry.markDead();
        state.lastPush = { success: false, error: msg, ts: new Date().toISOString() };
        return false;
    }
}

/**
 * Main push loop — runs every PUSH_INTERVAL ms.
 * Logic mirrors the Python push_loop exactly.
 */
async function pushLoop(stopSignal) {
    logger.info(`[Loop] Push loop    — interval ${env.PUSH_INTERVAL}ms`);
    logger.info(`[Loop] Ingest URL   — ${INGEST_URL}`);

    while (!stopSignal.stopped) {
        await sleep(env.PUSH_INTERVAL);
        if (stopSignal.stopped) break;

        // Gate: PLC must be online with at least one valid snapshot
        if (!state.plcOnline) {
            logger.debug('[Push] Skipped — PLC offline');
            continue;
        }
        if (!state.plcHasLiveData) {
            logger.debug('[Push] Skipped — waiting for first PLC snapshot');
            continue;
        }

        // Health check FIRST
        const healthy = await checkHealth();

        const signature = currentSignature();
        const dataChanged = signature !== _lastQueuedSignature;

        if (!healthy) {
            const pending = walPending().length;
            if (dataChanged) {
                const payload = buildPayload();
                WALEntry.create(payload);
                _lastQueuedSignature = signature;
                logger.info(`[Push] Server unhealthy — new batch queued (total pending=${pending + 1})`);
            } else {
                logger.debug(`[Push] Server unhealthy + no data change — skipping (pending=${pending})`);
            }
            continue;
        }

        if (!dataChanged) {
            logger.debug('[Push] Skipped — no PLC value change since last batch');
            continue;
        }

        // Server healthy + data changed → write WAL then flush
        const payload = buildPayload();
        WALEntry.create(payload);
        _lastQueuedSignature = signature;

        const pending = walPending();
        logger.debug(`[Push] Flushing ${pending.length} pending batch(es)`);

        for (const entry of pending) {
            const ok = await pushOne(entry);
            if (!ok) break; // stop flush on first failure, retry next cycle
        }

        // Housekeeping
        pruneSent();
    }
}

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

module.exports = { pushLoop, buildPayload };