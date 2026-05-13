'use strict';

const { state } = require('./stateManager');

/**
 * Returns a JSON string fingerprint of all PLC-derived analog values.
 * Two identical snapshots will produce the same signature.
 * Timestamps and sequence numbers are excluded deliberately.
 *
 * @returns {string}
 */
function currentSignature() {
    return JSON.stringify([
        +state.extruderRpm.toFixed(2),
        +state.extruderAmp.toFixed(2),
        state.extruderPct,
        +state.laminatorMpm.toFixed(2),
        +state.laminatorAmp.toFixed(2),
        state.laminatorPct,
        +state.winderAmp.toFixed(2),
        state.winderTenPct,
        +state.runningMeter.toFixed(1),
        +state.totalMeter.toFixed(1),
        +state.gsm.toFixed(2),
        +state.gram.toFixed(2),
        state.uwSetTension,
        state.uwPvTension,
        +state.extSpeedVol.toFixed(2),
        +state.lamSpeedVol.toFixed(2),
        +state.winderTenVol.toFixed(2),
        state.emgStop ? 1 : 0,
    ]);
}

module.exports = { currentSignature };