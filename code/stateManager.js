'use strict';

/**
 * Central mutable runtime state for the pipeline.
 * All modules share this single object by reference.
 */
const state = {
    // Modbus connection
    plcOnline: false,
    plcHasLiveData: false,
    plcError: null,

    // Sequence counter for outbound batches
    ingestSeq: 0,

    // Latest tag values from PLC (keyed by tag name)
    tags: {},

    // Web dashboard fields
    connected: false,
    readCount: 0,
    ts: null,
    lastPush: { success: null, error: null, ts: null },

    // Analog fields (kept separate for fast signature computation)
    extruderRpm: 0.0,
    extruderAmp: 0.0,
    extruderPct: 0,
    laminatorMpm: 0.0,
    laminatorAmp: 0.0,
    laminatorPct: 0,
    winderAmp: 0.0,
    winderTenPct: 0,
    runningMeter: 0.0,
    totalMeter: 0.0,
    gsm: 0.0,
    gram: 0.0,
    uwSetTension: 0,
    uwPvTension: 0,
    extSpeedVol: 0.0,
    lamSpeedVol: 0.0,
    winderTenVol: 0.0,
    emgStop: false,
};

/**
 * Apply a polled Modbus snapshot to state.
 * Does NOT overwrite a field if the polled value is undefined/null.
 *
 * @param {Object} values - { TAG_NAME: value, ... }
 */
function applySnapshot(values) {
    const g = (key, fallback) => (values[key] !== undefined && values[key] !== null) ? values[key] : fallback;

    state.extruderRpm = parseFloat(g('EXTRUDER_RPM', state.extruderRpm));
    state.extruderAmp = parseFloat(g('EXTRUDER_AMP', state.extruderAmp));
    state.extruderPct = parseInt(g('EXTRUDER_SPEED_PCT', state.extruderPct));
    state.laminatorMpm = parseFloat(g('LAMINATOR_MPM', state.laminatorMpm));
    state.laminatorAmp = parseFloat(g('LAMINATOR_AMP', state.laminatorAmp));
    state.laminatorPct = parseInt(g('LAMINATOR_SPEED_PCT', state.laminatorPct));
    state.winderAmp = parseFloat(g('WINDER_AMP', state.winderAmp));
    state.winderTenPct = parseInt(g('WINDER_TENSION_PCT', state.winderTenPct));
    state.runningMeter = parseFloat(g('RUNNING_METER', state.runningMeter)) / 1000;
    state.totalMeter = parseFloat(g('TOTAL_METER', state.totalMeter)) / 1000;
    state.gsm = parseFloat(g('GSM_ENTRY', state.gsm));
    state.gram = parseFloat(g('GRAM_ENTRY', state.gram));
    state.uwSetTension = parseInt(g('UW_SET_TENSION', state.uwSetTension)) / 10;
    state.uwPvTension = parseInt(g('UW_PV_TENSION', state.uwPvTension)) / 10;
    state.extSpeedVol = parseFloat(g('EXTRUDER_SPEED_VOL', state.extSpeedVol));
    state.lamSpeedVol = parseFloat(g('LAMINATOR_SPEED_VOL', state.lamSpeedVol));
    state.winderTenVol = parseFloat(g('WINDER_TENSION_VOL', state.winderTenVol));
    state.emgStop = Boolean(g('EMG_STOP', state.emgStop));

    // Scale specific tags in the 'values' object for the dashboard/API
    if (values.RUNNING_METER !== undefined) values.RUNNING_METER /= 1000;
    if (values.TOTAL_METER !== undefined) values.TOTAL_METER /= 1000;
    if (values.UW_SET_TENSION !== undefined) values.UW_SET_TENSION /= 10;
    if (values.UW_PV_TENSION !== undefined) values.UW_PV_TENSION /= 10;

    // Merge all tag values into state.tags for dashboard API
    Object.assign(state.tags, values);

    state.readCount++;
    state.ts = new Date().toISOString();
    state.connected = true;
}

module.exports = { state, applySnapshot };