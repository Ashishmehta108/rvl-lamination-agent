'use strict';

/**
 * Nonwoven Agent Orchestrator
 * Links Modbus polling, data pushing, and serves the monitoring dashboard.
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const logger = require('./logger');
const env = require('./env');
const { state } = require('./stateManager');
const { modbusPollLoop } = require('./modbusClient');
const { pushLoop } = require('./pushManager');

const stopSignal = { stopped: false };

/**
 * Minimal HTTP server for the Dashboard
 */
const server = http.createServer((req, res) => {
    // API: Get current state
    if (req.url === '/api/state') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(state));
        return;
    }

    // Static: Dashboard HTML
    if (req.url === '/' || req.url === '/index.html') {
        const htmlPath = path.join(__dirname, 'dashboard.html');
        fs.readFile(htmlPath, (err, data) => {
            if (err) {
                res.writeHead(500);
                res.end('Error loading dashboard.html');
                return;
            }
            res.writeHead(200, { 'Content-Type': 'text/html' });
            res.end(data);
        });
        return;
    }

    // 404
    res.writeHead(404);
    res.end('Not Found');
});

/**
 * Shutdown handler
 */
async function shutdown() {
    if (stopSignal.stopped) return;
    logger.info('[App] Shutting down...');
    stopSignal.stopped = true;
    server.close();
    process.exit(0);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

/**
 * Bootstrap
 */
async function main() {
    logger.info('================================================');
    logger.info(`[App] Starting Nonwoven AI Agent v2.0`);
    logger.info(`[App] Machine ID: ${env.MACHINE_ID}`);
    logger.info(`[App] Dashboard: http://localhost:${env.WEB_PORT}`);
    logger.info('================================================');

    // Start Dashboard Server
    server.listen(env.WEB_PORT, '0.0.0.0', () => {
        logger.info(`[HTTP] Dashboard server listening on port ${env.WEB_PORT}`);
    });

    // Start Modbus Loop (Async)
    modbusPollLoop(stopSignal).catch(err => {
        logger.error(`[Modbus] Fatal error in poll loop: ${err.message}`);
    });

    // Start Push Loop (Async)
    pushLoop(stopSignal).catch(err => {
        logger.error(`[Push] Fatal error in push loop: ${err.message}`);
    });
}

main().catch(err => {
    logger.error(`[App] Bootstrap failed: ${err.message}`);
    process.exit(1);
});
