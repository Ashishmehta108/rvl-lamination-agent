'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

/**
 * Atomically write JSON to `targetPath`.
 * Strategy: write to temp file → fsync → rename
 * Safe against power-loss mid-write.
 *
 * @param {string} targetPath  - Final destination path
 * @param {object} data        - Object to serialize as JSON
 */
function atomicWriteJSON(targetPath, data) {
    const dir = path.dirname(targetPath);
    const tmpPath = path.join(dir, `.tmp_${Date.now()}_${Math.random().toString(36).slice(2)}`);

    const json = JSON.stringify(data, null, 2);
    const fd = fs.openSync(tmpPath, 'w');
    try {
        fs.writeSync(fd, json);
        fs.fsyncSync(fd);
    } finally {
        fs.closeSync(fd);
    }
    fs.renameSync(tmpPath, targetPath);
}

module.exports = { atomicWriteJSON };