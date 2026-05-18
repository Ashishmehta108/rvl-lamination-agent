'use strict';

/**
 * Tag definitions for the Nonwoven Lamination Machine — Patch v2
 *
 * ── Address encoding (MUST match modbusClient.js getReg()) ──────────────────
 *  getReg(addr) = addr >= 400000 ? addr - 400000 : addr
 *
 *  FC3 holding registers  → store the 4xxxxx display address (e.g. 401104)
 *                           getReg() subtracts 400000 → register offset 1104
 *                           readHoldingRegisters(1104, 2) for float
 *                           readHoldingRegisters(1104, 1) for uint16
 *
 *  FC1 coils              → store coil number as-is (e.g. 100)
 *                           getReg() returns it unchanged (< 400000)
 *                           readCoils(100, 1)
 *
 *  FC4 input registers    → stored as raw IREG offset; getReg() passes through
 *                           *** FC4 is NOT YET implemented in modbusClient.js ***
 *                           See SPARE_ANALOG tags at bottom for instructions.
 *
 * ── Float word order ────────────────────────────────────────────────────────
 *  cdabToFloat(hi, lo): PLC sends CDAB.
 *  First register = high word (buf[2-3]), second = low word (buf[0-1]).
 *
 * ── Fields ──────────────────────────────────────────────────────────────────
 *  addr        - address as described above
 *  type        - 'float' | 'uint16' | 'bool'
 *  fc          - Modbus function code: 1=ReadCoils, 3=ReadHoldingRegisters, 4=ReadInputRegisters
 *  label       - Human-readable label
 *  unit        - Engineering unit string
 *  section     - Dashboard section grouping
 *  warn_hi     - High warning threshold  (null = none)
 *  warn_lo     - Low warning threshold   (null = none)
 *  alarm_hi    - High alarm threshold    (null = none)
 *  alarm_lo    - Low alarm threshold     (null = none)
 *  isFault     - true if truthy value = fault/alarm state
 *  readonly    - true if tag should not be written to
 *  description - optional context string for AI agent
 */

const TAGS = {

    // ── MASTER / LINE ─────────────────────────────────────────────────────────
    MASTER_SPEED_PCT: {
        addr: 400000, type: 'uint16', fc: 3,
        label: 'Master Speed', unit: '%', section: 'master',
        warn_hi: 95, warn_lo: 10, alarm_hi: 100, alarm_lo: 5,
        description: 'Overall line speed setpoint as % of MACHINE_MAX_LINE_SPEED',
    },
    MACHINE_MAX_LINE_SPEED: {
        addr: 403041, type: 'float', fc: 3,
        label: 'Machine Max Line Speed', unit: 'm/min', section: 'master',
        warn_hi: null, warn_lo: null, alarm_hi: null, alarm_lo: null,
        readonly: true,
        description: 'Reference: 100% corresponds to this value in m/min. Multiply MASTER_SPEED_PCT/100 to get actual line speed',
    },

    // ── EXTRUDER ──────────────────────────────────────────────────────────────
    EXTRUDER_ON_OFF: {
        addr: 100, type: 'bool', fc: 1,
        label: 'Extruder ON/OFF', unit: '', section: 'extruder',
        warn_hi: null, warn_lo: null, alarm_hi: null, alarm_lo: null,
    },
    EXTRUDER_FAULT: {
        addr: 12, type: 'bool', fc: 1,
        label: 'Extruder Fault', unit: '', section: 'extruder',
        warn_hi: null, warn_lo: null, alarm_hi: null, alarm_lo: null,
        isFault: true, readonly: true,
    },
    EXTRUDER_SPEED_PCT: {
        addr: 400001, type: 'uint16', fc: 3,
        label: 'Extruder Speed', unit: '%', section: 'extruder',
        warn_hi: 95, warn_lo: 5, alarm_hi: 100, alarm_lo: 0,
    },
    EXTRUDER_RPM: {
        addr: 401104, type: 'float', fc: 3,
        label: 'Extruder RPM', unit: 'RPM', section: 'extruder',
        warn_hi: 80, warn_lo: 5, alarm_hi: 100, alarm_lo: 0,
        readonly: true,
    },
    EXTRUDER_MAX_RPM: {
        addr: 400024, type: 'float', fc: 3,
        label: 'Extruder Max RPM', unit: 'RPM', section: 'extruder',
        warn_hi: null, warn_lo: null, alarm_hi: null, alarm_lo: null,
        readonly: true,
        description: 'Configured RPM ceiling — compare with EXTRUDER_RPM to calculate headroom',
    },
    EXTRUDER_AMP: {
        addr: 401108, type: 'float', fc: 3,
        label: 'Extruder Amps', unit: 'A', section: 'extruder',
        warn_hi: 35, warn_lo: null, alarm_hi: 40, alarm_lo: null,
        readonly: true,
    },
    EXTRUDER_SPEED_VOL: {
        addr: 401200, type: 'float', fc: 3,
        label: 'Extruder Speed Voltage', unit: 'V', section: 'extruder',
        warn_hi: null, warn_lo: null, alarm_hi: null, alarm_lo: null,
        readonly: true,
        description: 'Raw analog speed reference voltage — diagnostic use only',
    },
    EXTRUDER_FWD_REV_ELR_FAULT: {
        addr: 63496, type: 'bool', fc: 1,
        label: 'Extruder FWD/REV SSR Fault', unit: '', section: 'extruder',
        warn_hi: null, warn_lo: null, alarm_hi: null, alarm_lo: null,
        isFault: true, readonly: true,
        description: 'X10 input bit — solid-state relay fault for extruder direction control',
    },

    // ── LAMINATOR ─────────────────────────────────────────────────────────────
    LAMINATOR_ON_OFF: {
        addr: 101, type: 'bool', fc: 1,
        label: 'Laminator ON/OFF', unit: '', section: 'laminator',
        warn_hi: null, warn_lo: null, alarm_hi: null, alarm_lo: null,
    },
    LAMINATOR_FAULT: {
        addr: 13, type: 'bool', fc: 1,
        label: 'Laminator Fault', unit: '', section: 'laminator',
        warn_hi: null, warn_lo: null, alarm_hi: null, alarm_lo: null,
        isFault: true, readonly: true,
    },
    LAMINATOR_UP_IND: {
        addr: 161, type: 'bool', fc: 1,
        label: 'Laminator Raised (Indicator)', unit: '', section: 'laminator',
        warn_hi: null, warn_lo: null, alarm_hi: null, alarm_lo: null,
        readonly: true,
    },
    LAMINATOR_DOWN_IND: {
        addr: 162, type: 'bool', fc: 1,
        label: 'Laminator Lowered (Indicator)', unit: '', section: 'laminator',
        warn_hi: null, warn_lo: null, alarm_hi: null, alarm_lo: null,
        readonly: true,
    },
    LAMINATOR_RUBBER_ROLL_OPEN: {
        addr: 105, type: 'bool', fc: 1,
        label: 'Rubber Roll Open', unit: '', section: 'laminator',
        warn_hi: null, warn_lo: null, alarm_hi: null, alarm_lo: null,
        description: 'Rubber roll retracted — no lamination contact',
    },
    LAMINATOR_RUBBER_ROLL_CLOSE: {
        addr: 106, type: 'bool', fc: 1,
        label: 'Rubber Roll Closed', unit: '', section: 'laminator',
        warn_hi: null, warn_lo: null, alarm_hi: null, alarm_lo: null,
        description: 'Rubber roll engaged — lamination contact active',
    },
    LAMINATOR_SPEED_PCT: {
        addr: 400002, type: 'uint16', fc: 3,
        label: 'Laminator Speed', unit: '%', section: 'laminator',
        warn_hi: 95, warn_lo: 5, alarm_hi: 100, alarm_lo: 0,
    },
    LAMINATOR_MPM: {
        addr: 401106, type: 'float', fc: 3,
        label: 'Laminator Speed', unit: 'm/min', section: 'laminator',
        warn_hi: 130, warn_lo: 5, alarm_hi: 150, alarm_lo: 0,
        readonly: true,
    },
    LAMINATOR_MAX_RPM: {
        addr: 400026, type: 'float', fc: 3,
        label: 'Laminator Max RPM', unit: 'RPM', section: 'laminator',
        warn_hi: null, warn_lo: null, alarm_hi: null, alarm_lo: null,
        readonly: true,
        description: 'Configured RPM ceiling for laminator drive',
    },
    LAMINATOR_ROLL_DIA: {
        addr: 400220, type: 'float', fc: 3,
        label: 'Laminator Roll Diameter', unit: 'mm', section: 'laminator',
        warn_hi: null, warn_lo: null, alarm_hi: null, alarm_lo: null,
        readonly: true,
        description: 'Used in MPM calculation — context for interpreting speed values',
    },
    LAMINATOR_AMP: {
        addr: 401110, type: 'float', fc: 3,
        label: 'Laminator Amps', unit: 'A', section: 'laminator',
        warn_hi: 12, warn_lo: null, alarm_hi: 15, alarm_lo: null,
        readonly: true,
    },
    LAMINATOR_SPEED_VOL: {
        addr: 401202, type: 'float', fc: 3,
        label: 'Laminator Speed Voltage', unit: 'V', section: 'laminator',
        warn_hi: null, warn_lo: null, alarm_hi: null, alarm_lo: null,
        readonly: true,
        description: 'Raw analog speed reference voltage — diagnostic use only',
    },
    LAMINATOR_UP_DOWN_ELR_FAULT: {
        addr: 63497, type: 'bool', fc: 1,
        label: 'Laminator Up/Down SSR Fault', unit: '', section: 'laminator',
        warn_hi: null, warn_lo: null, alarm_hi: null, alarm_lo: null,
        isFault: true, readonly: true,
        description: 'X11 input bit — SSR fault for laminator vertical movement',
    },

    // ── WINDER ────────────────────────────────────────────────────────────────
    WINDER_ON_OFF: {
        addr: 102, type: 'bool', fc: 1,
        label: 'Winder ON/OFF', unit: '', section: 'winder',
        warn_hi: null, warn_lo: null, alarm_hi: null, alarm_lo: null,
    },
    WINDER_FAULT: {
        addr: 14, type: 'bool', fc: 1,
        label: 'Winder Fault', unit: '', section: 'winder',
        warn_hi: null, warn_lo: null, alarm_hi: null, alarm_lo: null,
        isFault: true, readonly: true,
    },
    WINDER_DANCER_MODE: {
        addr: 612, type: 'bool', fc: 1,
        label: 'Winder Dancer Mode', unit: '', section: 'winder',
        warn_hi: null, warn_lo: null, alarm_hi: null, alarm_lo: null,
        description: 'ON = dancer roll tension control; OFF = torque/speed control',
    },
    CONTACT_WINDER: {
        addr: 527, type: 'bool', fc: 1,
        label: 'Contact Winder Mode', unit: '', section: 'winder',
        warn_hi: null, warn_lo: null, alarm_hi: null, alarm_lo: null,
        description: 'ON = contact winder (lay-on roll active); affects roll hardness at speed',
    },
    WINDER_TENSION_PCT: {
        addr: 400003, type: 'uint16', fc: 3,
        label: 'Winder Tension', unit: '%', section: 'winder',
        warn_hi: 80, warn_lo: 10, alarm_hi: 90, alarm_lo: 5,
    },
    WINDER_AMP: {
        addr: 401112, type: 'float', fc: 3,
        label: 'Winder Amps', unit: 'A', section: 'winder',
        warn_hi: 8, warn_lo: null, alarm_hi: 12, alarm_lo: null,
        readonly: true,
    },
    WINDER_TENSION_VOL: {
        addr: 401040, type: 'float', fc: 3,
        label: 'Winder Tension Voltage', unit: 'V', section: 'winder',
        warn_hi: null, warn_lo: null, alarm_hi: null, alarm_lo: null,
        readonly: true,
        description: 'Raw analog tension voltage — diagnostic use only',
    },

    // ── UNWINDER (Main) ───────────────────────────────────────────────────────
    UW_SET_TENSION: {
        addr: 403502, type: 'uint16', fc: 3,
        label: 'Unwinder Set Tension', unit: 'counts', section: 'unwinder',
        warn_hi: null, warn_lo: null, alarm_hi: null, alarm_lo: null,
        description: 'Tension setpoint in raw loadcell counts',
    },
    UW_PV_TENSION: {
        addr: 403880, type: 'uint16', fc: 3,
        label: 'Unwinder Actual Tension (Raw)', unit: 'counts', section: 'unwinder',
        warn_hi: null, warn_lo: null, alarm_hi: null, alarm_lo: null,
        readonly: true,
        description: 'Unfiltered loadcell reading — use UW_PV_TENSION_FILTERED for display/trend',
    },
    UW_PV_TENSION_FILTERED: {
        addr: 403880, type: 'uint16', fc: 3,
        label: 'Unwinder Actual Tension (Filtered)', unit: 'counts', section: 'unwinder',
        warn_hi: null, warn_lo: null, alarm_hi: null, alarm_lo: null,
        readonly: true,
        description: 'Filtered loadcell reading — preferred for dashboard and trend charts',
    },
    UW_BREAK_CHANGE_MPM: {
        addr: 401140, type: 'float', fc: 3,
        label: 'Unwinder Brake Changeover Speed', unit: 'm/min', section: 'unwinder',
        warn_hi: null, warn_lo: null, alarm_hi: null, alarm_lo: null,
        description: 'Line speed at which UW brake control transitions mode',
    },
    UW_WEB_ALIGNER_FAULT: {
        addr: 63499, type: 'bool', fc: 1,
        label: 'Unwinder Web Aligner Fault', unit: '', section: 'unwinder',
        warn_hi: null, warn_lo: null, alarm_hi: null, alarm_lo: null,
        isFault: true, readonly: true,
        description: 'X13 input bit',
    },

    // ── SANDWICH UNWINDER ─────────────────────────────────────────────────────
    SANDWICH_UW_ENABLE: {
        addr: 520, type: 'bool', fc: 1,
        label: 'Sandwich Unwinder Enable', unit: '', section: 'sandwich_unwinder',
        warn_hi: null, warn_lo: null, alarm_hi: null, alarm_lo: null,
        description: 'ON = second film layer active. If OFF, sandwich lamination is not running',
    },
    SUW_SET_TENSION: {
        addr: 401852, type: 'uint16', fc: 3,
        label: 'Sandwich UW Set Tension', unit: 'counts', section: 'sandwich_unwinder',
        warn_hi: null, warn_lo: null, alarm_hi: null, alarm_lo: null,
    },
    SUW_PV_TENSION: {
        addr: 401830, type: 'uint16', fc: 3,
        label: 'Sandwich UW Actual Tension (Filtered)', unit: 'counts', section: 'sandwich_unwinder',
        warn_hi: null, warn_lo: null, alarm_hi: null, alarm_lo: null,
        readonly: true,
    },

    // ── HOTPLATE ──────────────────────────────────────────────────────────────
    // PLC coil offset notes:
    //   HOTPLATE_ENABLE    → PLC M521,  coil offset 521  (addr stored as 521)
    //   HOTPLATE_OPEN      → PLC M180,  coil offset 180
    //   HOTPLATE_CLOSE     → PLC named M181 but ACTUAL offset is 182 (HMI naming error)
    //   HOTPLATE_AUTO_CLOSE_ENABLE → PLC M522, coil offset 522
    HOTPLATE_ENABLE: {
        addr: 521, type: 'bool', fc: 1,
        label: 'Hotplate Enable', unit: '', section: 'hotplate',
        warn_hi: null, warn_lo: null, alarm_hi: null, alarm_lo: null,
        description: 'Master enable for unwinder hotplate subsystem',
    },
    HOTPLATE_OPEN: {
        addr: 180, type: 'bool', fc: 1,
        label: 'Hotplate Open', unit: '', section: 'hotplate',
        warn_hi: null, warn_lo: null, alarm_hi: null, alarm_lo: null,
        description: 'Hotplate retracted away from substrate',
    },
    HOTPLATE_CLOSE: {
        addr: 182, type: 'bool', fc: 1,  // ACTUAL coil offset 182 — HMI names it M181
        label: 'Hotplate Closed', unit: '', section: 'hotplate',
        warn_hi: null, warn_lo: null, alarm_hi: null, alarm_lo: null,
        description: 'Hotplate in contact with substrate. NOTE: PLC offset=182, HMI tag=M181 (naming error)',
    },
    HOTPLATE_AUTO_CLOSE_ENABLE: {
        addr: 522, type: 'bool', fc: 1,
        label: 'Hotplate Auto-Close Enable', unit: '', section: 'hotplate',
        warn_hi: null, warn_lo: null, alarm_hi: null, alarm_lo: null,
        description: 'When ON, hotplate closes automatically above HOTPLATE_AUTO_CLOSE_MPM',
    },
    HOTPLATE_AUTO_CLOSE_MPM: {
        addr: 402050, type: 'float', fc: 3,
        label: 'Hotplate Auto-Close Speed', unit: 'm/min', section: 'hotplate',
        warn_hi: null, warn_lo: null, alarm_hi: null, alarm_lo: null,
        description: 'Line speed above which hotplate auto-closes during startup ramp',
    },
    HEATING_PANEL_MCCB_TRIP: {
        addr: 63519, type: 'bool', fc: 1,  // X37 = coil 63488 + 37 - 1 = 63524? verify on your panel
        label: 'Heating Panel MCCB Trip', unit: '', section: 'hotplate',
        warn_hi: null, warn_lo: null, alarm_hi: null, alarm_lo: null,
        isFault: true, readonly: true,
        description: 'X37 Mitsubishi input bit — heater panel main circuit breaker tripped',
    },

    // ── PRODUCTION ────────────────────────────────────────────────────────────
    RUNNING_METER: {
        addr: 400008, type: 'float', fc: 3,
        label: 'Running Meter', unit: 'm', section: 'meters',
        warn_hi: null, warn_lo: null, alarm_hi: null, alarm_lo: null,
        readonly: true,
        description: 'Cumulative meters for current roll — resets on roll change',
    },
    TOTAL_METER: {
        addr: 400010, type: 'float', fc: 3,
        label: 'Total Meter', unit: 'm', section: 'meters',
        warn_hi: null, warn_lo: null, alarm_hi: null, alarm_lo: null,
        readonly: true,
        description: 'Lifetime cumulative meters',
    },
    GSM_ENTRY: {
        addr: 401300, type: 'float', fc: 3,
        label: 'GSM Entry', unit: 'g/m²', section: 'gsm',
        warn_hi: null, warn_lo: null, alarm_hi: null, alarm_lo: null,
        description: 'GSM target setpoint — check GSM_SELECTION to confirm GSM mode is active',
    },
    GRAM_ENTRY: {
        addr: 403004, type: 'float', fc: 3,
        label: 'Gram Entry', unit: 'g', section: 'gsm',
        warn_hi: null, warn_lo: null, alarm_hi: null, alarm_lo: null,
    },
    FABRIC_SIZE: {
        addr: 401296, type: 'float', fc: 3,
        label: 'Fabric Width', unit: 'mm', section: 'gsm',
        warn_hi: null, warn_lo: null, alarm_hi: null, alarm_lo: null,
        description: 'Fabric width — context for GSM/gram calculation',
    },
    GSM_SELECTION: {
        addr: 634, type: 'bool', fc: 1,
        label: 'GSM Mode Active', unit: '', section: 'gsm',
        warn_hi: null, warn_lo: null, alarm_hi: null, alarm_lo: null,
        description: 'ON = machine currently in GSM control mode',
    },
    GRAM_LOGIC_SELECTION: {
        addr: 900, type: 'bool', fc: 1,
        label: 'Gram Logic Mode Active', unit: '', section: 'gsm',
        warn_hi: null, warn_lo: null, alarm_hi: null, alarm_lo: null,
        description: 'ON = machine currently in gram control mode',
    },
    GRAM_ENABLE: {
        addr: 635, type: 'bool', fc: 1,
        label: 'Gram Enable', unit: '', section: 'gsm',
        warn_hi: null, warn_lo: null, alarm_hi: null, alarm_lo: null,
    },
    GRAM_APPLY: {
        addr: 3002, type: 'bool', fc: 1,
        label: 'Gram Apply', unit: '', section: 'gsm',
        warn_hi: null, warn_lo: null, alarm_hi: null, alarm_lo: null,
    },

    // ── SPLICE ────────────────────────────────────────────────────────────────
    SPLICE_ON_OFF: {
        addr: 111, type: 'bool', fc: 1,
        label: 'Splice ON/OFF', unit: '', section: 'splice',
        warn_hi: null, warn_lo: null, alarm_hi: null, alarm_lo: null,
    },
    SPLICE_SPEED: {
        addr: 400018, type: 'uint16', fc: 3,
        label: 'Splice Speed', unit: '%', section: 'splice',
        warn_hi: null, warn_lo: null, alarm_hi: null, alarm_lo: null,
        description: 'Speed during splice sequence as % of max',
    },
    SPLICE_ACC_TIME: {
        addr: 400019, type: 'uint16', fc: 3,
        label: 'Splice Acceleration Time', unit: 's', section: 'splice',
        warn_hi: null, warn_lo: null, alarm_hi: null, alarm_lo: null,
    },
    SPLICE_DCC_TIME: {
        addr: 400020, type: 'uint16', fc: 3,
        label: 'Splice Deceleration Time', unit: 's', section: 'splice',
        warn_hi: null, warn_lo: null, alarm_hi: null, alarm_lo: null,
    },

    // ── ALARMS & SAFETY ───────────────────────────────────────────────────────
    ALARM_IND: {
        addr: 125, type: 'bool', fc: 1,
        label: 'Alarm Indicator', unit: '', section: 'alarms',
        warn_hi: null, warn_lo: null, alarm_hi: null, alarm_lo: null,
        isFault: true, readonly: true,
    },
    EMG_STOP: {
        addr: 9, type: 'bool', fc: 1,
        label: 'Emergency Stop', unit: '', section: 'alarms',
        warn_hi: null, warn_lo: null, alarm_hi: null, alarm_lo: null,
        isFault: true, readonly: true,
        description: 'M9 bit — active HIGH = emergency stop engaged',
    },
    LOGIC_ENABLE: {
        addr: 620, type: 'bool', fc: 1,
        label: 'Logic Enable', unit: '', section: 'alarms',
        warn_hi: null, warn_lo: null, alarm_hi: null, alarm_lo: null,
        description: 'Master logic gate — if OFF, all drives are inhibited even if ON/OFF bits are set',
    },
    AIR_PRESSURE_LOW: {
        addr: 63493, type: 'bool', fc: 1,  // X5 = Mitsubishi input coil
        label: 'Air Pressure Low', unit: '', section: 'alarms',
        warn_hi: null, warn_lo: null, alarm_hi: null, alarm_lo: null,
        isFault: true, readonly: true,
        description: 'X5 input — pneumatic supply below threshold; affects nip pressure and laminator movement',
    },
    TRIM_BLOWER_ON_OFF: {
        addr: 108, type: 'bool', fc: 1,
        label: 'Trim Blower ON/OFF', unit: '', section: 'alarms',
        warn_hi: null, warn_lo: null, alarm_hi: null, alarm_lo: null,
    },
    TRIM_BLOWER_FAULT: {
        addr: 63498, type: 'bool', fc: 1,  // X12 Mitsubishi input
        label: 'Trim Blower Fault', unit: '', section: 'alarms',
        warn_hi: null, warn_lo: null, alarm_hi: null, alarm_lo: null,
        isFault: true, readonly: true,
        description: 'X12 input bit',
    },

    // ── PLC DIAGNOSTICS ───────────────────────────────────────────────────────
    PLC_RUN: {
        addr: 8000, type: 'bool', fc: 1,
        label: 'PLC Running', unit: '', section: 'plc',
        warn_hi: null, warn_lo: null, alarm_hi: null, alarm_lo: null,
        readonly: true,
        description: 'M8000 — ON when PLC scan is active. If OFF while machine is powered, PLC has stopped',
    },
    PLC_ERROR_IND: {
        addr: 8004, type: 'bool', fc: 1,
        label: 'PLC Error', unit: '', section: 'plc',
        warn_hi: null, warn_lo: null, alarm_hi: null, alarm_lo: null,
        isFault: true, readonly: true,
    },
    PLC_BATTERY_LOW: {
        addr: 8005, type: 'bool', fc: 1,
        label: 'PLC Battery Low', unit: '', section: 'plc',
        warn_hi: null, warn_lo: null, alarm_hi: null, alarm_lo: null,
        isFault: true, readonly: true,
    },

    // ── SPARE ANALOG INPUTS (future temperature wiring) ──────────────────────
    // These are FC4 (ReadInputRegisters) — currently NOT supported in modbusClient.js.
    //
    // To enable, add this branch to readTag() in modbusClient.js:
    //
    //   } else if (tag.fc === 4) {
    //     const reg = getReg(tag.addr);   // passes through unchanged (< 400000)
    //     const res = await client.readInputRegisters(reg, 1);
    //     return res.data[0];
    //   }
    //
    // Hardware: wire 4-20mA from temperature controller analog output
    //           → 4AD-1 module terminal CH1 / CH2.
    // Scaling:  temp_C = (raw / 4000) * (maxTemp - minTemp) + minTemp
    //           Confirm range from your temperature controller datasheet.
    SPARE_ANALOG_CH1: {
        addr: 313289, type: 'uint16', fc: 4,
        label: 'Spare Analog CH1 (4AD-1)', unit: 'counts', section: 'spare',
        warn_hi: null, warn_lo: null, alarm_hi: null, alarm_lo: null,
        readonly: true,
        description: 'Available for die zone temperature 4-20mA. FC4 not yet implemented in modbusClient.js',
    },
    SPARE_ANALOG_CH2: {
        addr: 313290, type: 'uint16', fc: 4,
        label: 'Spare Analog CH2 (4AD-1)', unit: 'counts', section: 'spare',
        warn_hi: null, warn_lo: null, alarm_hi: null, alarm_lo: null,
        readonly: true,
        description: 'Available for barrel temperature 4-20mA. FC4 not yet implemented in modbusClient.js',
    },
};

module.exports = { TAGS };