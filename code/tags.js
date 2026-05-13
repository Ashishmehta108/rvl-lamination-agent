'use strict';

/**
 * Tag definitions for the Nonwoven Lamination Machine.
 *
 * addr   - Modbus address (4xxxxx = holding register, 1xx = coil)
 * type   - 'float' | 'uint16' | 'bool'
 * fc     - Modbus function code: 1=ReadCoils, 3=ReadHoldingRegisters
 * label  - Human-readable label for dashboard
 * unit   - Engineering unit string
 * warn_hi  - Warning threshold (null = no threshold)
 * alarm_hi - Alarm threshold (null = no threshold)
 * section  - Dashboard section grouping
 * isFault  - true if a truthy value means fault/alarm state
 */
const TAGS = {
    // ── EXTRUDER ──────────────────────────────────────────────
    EXTRUDER_RPM: { addr: 401104, type: 'float', fc: 3, label: 'Extruder RPM', unit: 'RPM', warn_hi: 80, alarm_hi: 100, section: 'extruder' },
    EXTRUDER_AMP: { addr: 401108, type: 'float', fc: 3, label: 'Extruder Amps', unit: 'A', warn_hi: 35, alarm_hi: 40, section: 'extruder' },
    EXTRUDER_SPEED_PCT: { addr: 400001, type: 'uint16', fc: 3, label: 'Extruder Speed', unit: '%', warn_hi: 95, alarm_hi: 100, section: 'extruder' },
    EXTRUDER_ON_OFF: { addr: 100, type: 'bool', fc: 1, label: 'Extruder ON/OFF', unit: '', warn_hi: null, alarm_hi: null, section: 'extruder' },
    EXTRUDER_FAULT: { addr: 12, type: 'bool', fc: 1, label: 'Extruder Fault', unit: '', warn_hi: null, alarm_hi: null, section: 'extruder', isFault: true },
    EXTRUDER_SPEED_VOL: { addr: 401200, type: 'float', fc: 3, label: 'Extruder Speed Vol', unit: 'V', warn_hi: null, alarm_hi: null, section: 'extruder' },

    // ── LAMINATOR ─────────────────────────────────────────────
    LAMINATOR_MPM: { addr: 401106, type: 'float', fc: 3, label: 'Laminator MPM', unit: 'm/min', warn_hi: 130, alarm_hi: 150, section: 'laminator' },
    LAMINATOR_AMP: { addr: 401110, type: 'float', fc: 3, label: 'Laminator Amps', unit: 'A', warn_hi: 12, alarm_hi: 15, section: 'laminator' },
    LAMINATOR_SPEED_PCT: { addr: 400002, type: 'uint16', fc: 3, label: 'Laminator Speed', unit: '%', warn_hi: 95, alarm_hi: 100, section: 'laminator' },
    LAMINATOR_ON_OFF: { addr: 101, type: 'bool', fc: 1, label: 'Laminator ON/OFF', unit: '', warn_hi: null, alarm_hi: null, section: 'laminator' },
    LAMINATOR_FAULT: { addr: 13, type: 'bool', fc: 1, label: 'Laminator Fault', unit: '', warn_hi: null, alarm_hi: null, section: 'laminator', isFault: true },
    LAMINATOR_SPEED_VOL: { addr: 401202, type: 'float', fc: 3, label: 'Laminator Speed Vol', unit: 'V', warn_hi: null, alarm_hi: null, section: 'laminator' },

    // ── WINDER ────────────────────────────────────────────────
    WINDER_AMP: { addr: 401112, type: 'float', fc: 3, label: 'Winder Amps', unit: 'A', warn_hi: 8, alarm_hi: 12, section: 'winder' },
    WINDER_TENSION_PCT: { addr: 400003, type: 'uint16', fc: 3, label: 'Winder Tension', unit: '%', warn_hi: 80, alarm_hi: 90, section: 'winder' },
    WINDER_ON_OFF: { addr: 102, type: 'bool', fc: 1, label: 'Winder ON/OFF', unit: '', warn_hi: null, alarm_hi: null, section: 'winder' },
    WINDER_FAULT: { addr: 14, type: 'bool', fc: 1, label: 'Winder Fault', unit: '', warn_hi: null, alarm_hi: null, section: 'winder', isFault: true },
    WINDER_TENSION_VOL: { addr: 401040, type: 'float', fc: 3, label: 'Winder Tension Vol', unit: 'V', warn_hi: null, alarm_hi: null, section: 'winder' },

    // ── MASTER ────────────────────────────────────────────────
    MASTER_SPEED_PCT: { addr: 400000, type: 'uint16', fc: 3, label: 'Master Speed', unit: '%', warn_hi: 95, alarm_hi: 100, section: 'master' },

    // ── UNWINDER ──────────────────────────────────────────────
    UW_SET_TENSION: { addr: 403502, type: 'uint16', fc: 3, label: 'UW Set Tension', unit: '', warn_hi: null, alarm_hi: null, section: 'unwinder' },
    UW_PV_TENSION: { addr: 403880, type: 'uint16', fc: 3, label: 'UW Actual Tension', unit: '', warn_hi: null, alarm_hi: null, section: 'unwinder' },

    // ── PRODUCTION METERS ─────────────────────────────────────
    RUNNING_METER: { addr: 400008, type: 'float', fc: 3, label: 'Running Meter', unit: 'm', warn_hi: null, alarm_hi: null, section: 'meters' },
    TOTAL_METER: { addr: 400010, type: 'float', fc: 3, label: 'Total Meter', unit: 'm', warn_hi: null, alarm_hi: null, section: 'meters' },

    // ── GSM / GRAM ────────────────────────────────────────────
    GSM_ENTRY: { addr: 401300, type: 'float', fc: 3, label: 'GSM Entry', unit: 'g/m²', warn_hi: null, alarm_hi: null, section: 'gsm' },
    GRAM_ENTRY: { addr: 403004, type: 'float', fc: 3, label: 'Gram Entry', unit: 'g', warn_hi: null, alarm_hi: null, section: 'gsm' },

    // ── ALARMS & SAFETY ───────────────────────────────────────
    ALARM_IND: { addr: 125, type: 'bool', fc: 1, label: 'Alarm Indicator', unit: '', warn_hi: null, alarm_hi: null, section: 'alarms', isFault: true },
    EMG_STOP: { addr: 9, type: 'bool', fc: 1, label: 'Emergency Stop', unit: '', warn_hi: null, alarm_hi: null, section: 'alarms', isFault: true },

    // ── SPLICE ────────────────────────────────────────────────
    SPLICE_ON_OFF: { addr: 111, type: 'bool', fc: 1, label: 'Splice ON/OFF', unit: '', warn_hi: null, alarm_hi: null, section: 'splice' },
    SPLICE_SPEED: { addr: 400018, type: 'uint16', fc: 3, label: 'Splice Speed', unit: '', warn_hi: null, alarm_hi: null, section: 'splice' },
};

module.exports = { TAGS };