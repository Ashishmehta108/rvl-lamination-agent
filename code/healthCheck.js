'use strict';

const axios = require('axios');
const logger = require('./logger');
const env = require('./env');

const HEALTH_URL = env.REMOTE_BASE_URL.replace(/\/$/, '') + env.HEALTH_PATH;

let _serverHealthy = true; // optimistic

/** Perform GET /health. Updates and returns boolean healthy flag. */
async function checkHealth() {
    try {
        const res = await axios.get(HEALTH_URL, {
            timeout: env.HTTP_TIMEOUT,
            validateStatus: null, // don't throw on 4xx/5xx
        });
        const healthy = res.status === 200;
        if (healthy !== _serverHealthy) {
            if (healthy) logger.info(`[Health] OK  Server back online (${HEALTH_URL})`);
            else logger.warn(`[Health] DOWN Server unhealthy — status ${res.status}`);
        }
        _serverHealthy = healthy;
        return healthy;
    } catch (err) {
        if (_serverHealthy) logger.warn(`[Health] DOWN Server unreachable: ${err.message}`);
        _serverHealthy = false;
        return false;
    }
}

function isServerHealthy() { return _serverHealthy; }

module.exports = { checkHealth, isServerHealthy, HEALTH_URL };