'use strict';

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

function getEnv(key, defaultValue, parser) {
    const raw = process.env[key];
    if (raw === undefined || raw === '') return defaultValue;
    if (parser) return parser(raw);
    return raw;
}

module.exports = {
    // Modbus
    PLC_HOST: getEnv('PLC_HOST', '192.168.1.17'),
    PLC_PORT: getEnv('PLC_PORT', 502, parseInt),
    PLC_UNIT_ID: getEnv('PLC_UNIT_ID', 1, parseInt),
    MODBUS_TIMEOUT: getEnv('MODBUS_TIMEOUT', 3000, v => parseFloat(v) * 1000),

    // Timing (convert seconds → ms)
    UPDATE_INTERVAL: getEnv('UPDATE_INTERVAL', 500, v => parseFloat(v) * 1000),
    PUSH_INTERVAL: getEnv('PUSH_INTERVAL', 5000, v => parseFloat(v) * 1000),
    HTTP_TIMEOUT: getEnv('HTTP_TIMEOUT', 10000, v => parseFloat(v) * 1000),

    // Remote backend
    REMOTE_BASE_URL: getEnv('REMOTE_BASE_URL', 'https://mace-ebony-capital.ngrok-free.dev'),
    INGEST_PATH: getEnv('INGEST_PATH', '/ingest/tags'),
    HEALTH_PATH: getEnv('HEALTH_PATH', '/health'),
    API_AUTH_TOKEN: getEnv('API_AUTH_TOKEN', 'dev-local-token'),

    // Machine identity
    MACHINE_ID: getEnv('MACHINE_ID', 'lamination-01'),
    MACHINE_REVISION: getEnv('MACHINE_REVISION', 'v1'),

    // WAL / retry
    MAX_RETRIES: getEnv('MAX_RETRIES', 72, parseInt),
    RETRY_BACKOFF_CAP: getEnv('RETRY_BACKOFF_CAP', 60000, v => parseFloat(v) * 1000),
    SENT_KEEP_HOURS: getEnv('SENT_KEEP_HOURS', 24, parseFloat),

    // Snapshot validation
    MIN_SUCCESS_TAGS: getEnv('MIN_SUCCESS_TAGS', 8, parseInt),
    REQUIRED_LIVE_TAGS: getEnv(
        'REQUIRED_LIVE_TAGS',
        'EXTRUDER_RPM,LAMINATOR_MPM,EXTRUDER_SPEED_PCT'
    ).split(',').map(s => s.trim()).filter(Boolean),

    // Backoff
    POLL_BACKOFF_BASE: getEnv('POLL_BACKOFF_BASE', 1000, v => parseFloat(v) * 1000),
    POLL_BACKOFF_MAX: getEnv('POLL_BACKOFF_MAX', 30000, v => parseFloat(v) * 1000),
    POLL_JITTER_MAX: getEnv('POLL_JITTER_MAX', 200, v => parseFloat(v) * 1000),

    // Storage
    BASE_DIR: getEnv('BASE_DIR', path.join(__dirname, '..', 'storage')),

    // Web dashboard port
    WEB_PORT: getEnv('WEB_PORT', 5555, parseInt),

    // Log level
    LOG_LEVEL: getEnv('LOG_LEVEL', 'info'),
};