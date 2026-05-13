'use strict';

const path = require('path');
const winston = require('winston');
const DailyRot = require('winston-daily-rotate-file');
const env = require('./env');

const LOG_DIR = path.join(env.BASE_DIR, 'logs');

// Ensure log dir exists synchronously at startup
const fs = require('fs');
fs.mkdirSync(LOG_DIR, { recursive: true });

const fmt = winston.format.combine(
    winston.format.timestamp({ format: 'YYYY-MM-DDTHH:mm:ss' }),
    winston.format.printf(({ timestamp, level, message }) => {
        const lpad = level.toUpperCase().padEnd(8);
        return `${timestamp} [${lpad}] ${message}`;
    })
);

const logger = winston.createLogger({
    level: env.LOG_LEVEL,
    format: fmt,
    transports: [
        new winston.transports.Console({ format: fmt }),
        new DailyRot({
            dirname: LOG_DIR,
            filename: 'pipeline-%DATE%.log',
            datePattern: 'YYYY-MM-DD',
            maxSize: '10m',
            maxFiles: '7d',
            zippedArchive: true,
        }),
    ],
});

module.exports = logger;