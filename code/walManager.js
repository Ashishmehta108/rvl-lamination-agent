'use strict';

const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const { atomicWriteJSON } = require('./atomicWrite');
const logger = require('./logger');
const env = require('./env');

const WAL_DIR = path.join(env.BASE_DIR, 'wal');
const SENT_DIR = path.join(env.BASE_DIR, 'sent');
const DEAD_DIR = path.join(env.BASE_DIR, 'dead');

// Ensure directories exist
for (const dir of [WAL_DIR, SENT_DIR, DEAD_DIR]) {
    fs.mkdirSync(dir, { recursive: true });
}

/**
 * WALEntry wraps a single durable batch file.
 *
 * Filename: <seq10>__<uuid4>__<retryCount>.json
 * Contents:
 *   batch_id     - stable UUID for server-side idempotency
 *   seq          - monotonic sequence number
 *   retry_count  - incremented on each failed attempt
 *   last_error   - last error string
 *   created_at   - ISO timestamp of first write
 *   payload      - the IngestBatch JSON (never mutated)
 */
class WALEntry {
    constructor(filePath) {
        this.path = filePath;
    }

    /** Create and durably persist a new WAL entry. */
    static create(payload) {
        const batchId = uuidv4();
        const seq = payload.seq;
        const envelope = {
            batch_id: batchId,
            seq,
            retry_count: 0,
            last_error: null,
            created_at: new Date().toISOString(),
            payload,
        };
        const seqPadded = String(seq).padStart(10, '0');
        const filePath = path.join(WAL_DIR, `${seqPadded}__${batchId}__0.json`);
        atomicWriteJSON(filePath, envelope);
        logger.debug(`[WAL] Created  ${path.basename(filePath)}`);
        return new WALEntry(filePath);
    }

    load() {
        return JSON.parse(fs.readFileSync(this.path, 'utf8'));
    }

    /** Increment retry counter and persist atomically. */
    incrementRetry(error) {
        const data = this.load();
        data.retry_count += 1;
        data.last_error = String(error).slice(0, 200);
        const parts = path.basename(this.path).split('__');
        const newName = `${parts[0]}__${parts[1]}__${data.retry_count}.json`;
        const newPath = path.join(WAL_DIR, newName);
        atomicWriteJSON(newPath, data);
        if (this.path !== newPath && fs.existsSync(this.path)) {
            fs.unlinkSync(this.path);
        }
        this.path = newPath;
        logger.debug(`[WAL] Retry #${data.retry_count}  ${newName}  err=${data.last_error}`);
    }

    /** Move to sent/ directory. */
    markSent() {
        const dest = path.join(SENT_DIR, path.basename(this.path));
        fs.renameSync(this.path, dest);
        logger.debug(`[WAL] Sent     ${path.basename(dest)}`);
    }

    /** Move to dead/ directory — max retries exhausted. */
    markDead() {
        const dest = path.join(DEAD_DIR, path.basename(this.path));
        fs.renameSync(this.path, dest);
        logger.error(`[WAL] Dead     ${path.basename(dest)} (max retries exceeded)`);
    }

    get retryCount() {
        return parseInt(path.basename(this.path).split('__')[2], 10);
    }

    get seq() {
        return parseInt(path.basename(this.path).split('__')[0], 10);
    }
}

/** Returns all pending WAL entries sorted oldest-first. */
function walPending() {
    if (!fs.existsSync(WAL_DIR)) return [];
    return fs
        .readdirSync(WAL_DIR)
        .filter(f => f.endsWith('.json'))
        .sort()
        .map(f => new WALEntry(path.join(WAL_DIR, f)));
}

/** Delete sent entries older than SENT_KEEP_HOURS. */
function pruneSent() {
    if (!fs.existsSync(SENT_DIR)) return;
    const cutoff = Date.now() - env.SENT_KEEP_HOURS * 3_600_000;
    let pruned = 0;
    for (const f of fs.readdirSync(SENT_DIR)) {
        if (!f.endsWith('.json')) continue;
        const p = path.join(SENT_DIR, f);
        const stat = fs.statSync(p);
        if (stat.mtimeMs < cutoff) {
            fs.unlinkSync(p);
            pruned++;
        }
    }
    if (pruned > 0) logger.info(`[WAL] Pruned ${pruned} old sent entries`);
}

/** Count files in a directory. */
function countDir(dir) {
    if (!fs.existsSync(dir)) return 0;
    return fs.readdirSync(dir).filter(f => f.endsWith('.json')).length;
}

module.exports = {
    WALEntry,
    walPending,
    pruneSent,
    countDir,
    WAL_DIR,
    SENT_DIR,
    DEAD_DIR,
};