Lamination AI — Patch v2 Complete Plan
Ground truth from: ExportedTags__1_.xml (313 tags) + ExportedAlarms.xml (11 alarms) + agent.ts audit

1. Problems Confirmed and Root Causes
1.1 Missing Tags in TAGS Config (tags exist in PLC, not exposed to AI)
PLC Tag	Address	Type	Problem
MACHINE_MAX_LINE_SPEED_D3040	403041	float (HREG)	Speed % has no absolute reference. AI cannot say "you have X m/min headroom"
MAIN_UW_HOTPLATE_ENABLE_M521	522 (coil)	bool	Hotplate subsystem invisible to AI
MAIN_UW_HOTPLATE_OPEN_M180	181 (coil)	bool	Hotplate position invisible
MAIN_UW_HOTPLATE_CLOSE_M181	182 (coil)	bool	Named M181 but offset is 182 — naming error in HMI
MAIN_UW_HOTPLATE_AUTO_CLOSE_ENABLE_M522	523 (coil)	bool	Auto-close logic invisible
MAIN_UW_HOTPLATE_AUTO_CLOSE_MPM_D2050	402051	float (HREG)	Auto-close speed setpoint invisible
SANDWICH_UNWIDER_ENABLE_M520	521 (coil)	bool	Second film layer enable invisible
CONTACT_WINDER_M527	528 (coil)	bool	Contact winder mode invisible — affects roll quality
WINDER_DANCER_MODE_M612	613 (coil)	bool	Dancer mode invisible — tension control mode unknown
GSM_SELECTION_M634	635 (coil)	bool	AI reports GSM without knowing if GSM mode is active
GRAM_LOGIC_SELECTION_M900	901 (coil)	bool	AI reports gram without knowing if gram mode is active
EX_1_SC_1_GRAM_ENABLE_M635	636 (coil)	bool	Gram enable invisible
GRAM_APPLY_M3002	3003 (coil)	bool	Gram apply trigger invisible
FABRIC_SIZE_D1296	401297	float (HREG)	Fabric width invisible — affects GSM calculation context
LOGIC_ENABLE_M620	621 (coil)	bool	Master logic enable invisible — machine could be "on" but logic disabled
PID_SELECTION_M621	622 (coil)	bool	Tension PID mode invisible
PLC_RUN_M8000	8001 (coil)	bool	PLC scan running status invisible
PLC_BATTERY_LOW_IND_M8005	8006 (coil)	bool	Battery low indicator invisible
UW_PV_WITH_FILTER_D3880	403881	uint16 (HREG)	Actual unwinder tension (filtered) not in config
SUW_SET_TENSION_D1852	401853	uint16 (HREG)	Sandwich UW set tension not in config
SUW_PV_WITH_FILTER_D1830	401831	uint16 (HREG)	Sandwich UW actual tension not in config
EXTRUDER1_SCREW_1_MAX_RPM_D24	400025	float (HREG)	Max RPM limit invisible — AI can't say if extruder is near ceiling
LAMINATOR_1_MAX_RPM_D26	400027	float (HREG)	Laminator max RPM invisible
LAMINATOR_1_ROLL_DIA_D220	400221	float (HREG)	Roll diameter invisible — affects MPM calculation context
MAIN_UW_BREAK_CHANGE_MPM_D1140	401141	float (HREG)	Speed at which UW brake transitions — invisible
BRUSH_BLOWER_FAULT_RESET_M184	185 (coil)	bool	Brush blower exists, not monitored
LAMINATOR_1_RUBBER_ROLL_CLOSE_M106	107 (coil)	bool	Rubber roll position invisible — critical for lamination contact
LAMINATOR_1_RUBBER_ROLL_OPEN_M105	106 (coil)	bool	Rubber roll open state invisible
LAMINATOR_1_UP_IND_M161	162 (coil)	bool	Laminator raised indicator invisible
LAMINATOR_1_DOWN_IND_M162	163 (coil)	bool	Laminator lowered indicator invisible
SPLICE_ACC_TIME_D19	400020	uint16 (HREG)	Splice acceleration time invisible
SPLICE_DCC_TIME_D20	400021	uint16 (HREG)	Splice deceleration time invisible
1.2 Missing Alarm Coverage
Alarms in HMI that have no corresponding tag in TAGS config:

Alarm Name	Source Tag	Problem
EXTRUDER FWD_REV ELR FAULT	X10	SSR fault not monitored
LAMINATOR UP_DOWN ELR FAULT	X11	SSR fault not monitored
TRIM BLOWER FAULT	X12	Blower fault not monitored
UNWINDER WEB ALIGNER FAULT	X13	Web aligner fault not monitored
AIR PRESSURE LOW	X5	Pneumatic system invisible — directly affects nip pressure
HEATING PANEL MCCB TRIP	X37	Heater panel breaker trip not monitored
PLC ERROR	PLC_ERROR_IND_M8004	PLC error not in config
The X tags are Mitsubishi GX input bits (coils at offset 63489+). X5 = offset 63494, X10 = 63497, X11 = 63498, X12 = 63499, X13 = 63500, X37 = 63520.

1.3 Agent Code Bugs
Location	Bug	Impact
decomposeComplexQuery	References WINDER_TENSION — does not exist. Correct name is WINDER_TENSION_PCT	get_tag_history returns no data, agent concludes "no data" instead of diagnosing wiring mistake
inferUnit	Returns % for any tag containing TENSION — UW_PV_WITH_FILTER and SUW_PV_WITH_FILTER are raw counts, not %	Chart Y-axis shows wrong unit
shouldGenerateChart	Triggers on word "last" — so "what happened last shift" tries to chart EMG_STOP (boolean) as a line chart	Meaningless chart for boolean fault tags
buildHeuristicPlan (current default)	Falls through to get_active_alerts even for historical queries	Mixes present-state tool into historical query plan
ALL_TOOL_DECLARATIONS	No from/to defaults mentioned, so LLM sometimes omits them	get_tag_history called without time range returns unbounded data
System prompt subsystem list	Lists "Splice, Production, Safety" — does not mention Hotplate, Sandwich Unwinder, Web Aligner, Brush Blower	AI cannot classify or route queries about these subsystems
1.4 No Lower-Bound Alarms
Every tag with a numeric value has warn_lo: undefined and alarm_lo: undefined. Downward failures (speed drop, tension drop, RPM loss) fire no alert. This is the single biggest production risk.

1.5 No Temperature Monitoring
Confirmed from full XML scan: zero temperature tags exist anywhere in the PLC tag database. The only thermal signal is X37 (HEATING PANEL MCCB TRIP — binary fault only). The temperature controllers are external to the PLC.

Available spare analog channels for temperature wiring:

4AD-1_CH-1_SPARE_R1000 → IREG offset 313289
4AD-1_CH-2_SPARE_R1001 → IREG offset 313290
4DA-3_CH-1_SPARE_R1008 → IREG offset 313297
4DA-3_CH-2_SPARE_R1009 → IREG offset 313298
4DA-3_CH-3_SPARE_R1010 → IREG offset 313299
2. Complete Patched TAGS Config
// tags.ts — Patch v2
// Ground truth from ExportedTags__1_.xml (313 PLC tags)
// All addresses verified from resourceLocator/offset field
// FC1 = Read Coils (OUTP boolean), FC2 = Read Discrete Inputs (INP boolean)
// FC3 = Read Holding Registers (HREG), FC4 = Read Input Registers (IREG)
// Modbus TCP: addresses are used as-is (0-based protocol offset)

export type TagConfig = {
  addr: number;
  type: "bool" | "uint16" | "int16" | "float" | "binary";
  fc: 1 | 2 | 3 | 4;
  label: string;
  unit: string;
  subsystem: string;
  warn_hi: number | null;
  warn_lo: number | null;
  alarm_hi: number | null;
  alarm_lo: number | null;
  readonly?: boolean;
  description?: string;
};

export const TAGS: Record<string, TagConfig> = {

  // ─── MASTER / LINE ────────────────────────────────────────────────────────
  MASTER_SPEED_PCT: {
    addr: 400001, type: "uint16", fc: 3,
    label: "Master Speed", unit: "%", subsystem: "Line",
    warn_hi: 95, warn_lo: 10, alarm_hi: 100, alarm_lo: 5,
    description: "Overall line speed setpoint as % of MACHINE_MAX_LINE_SPEED"
  },
  MACHINE_MAX_LINE_SPEED: {
    addr: 403041, type: "float", fc: 3,
    label: "Machine Max Line Speed", unit: "m/min", subsystem: "Line",
    warn_hi: null, warn_lo: null, alarm_hi: null, alarm_lo: null,
    readonly: true,
    description: "Reference: 100% speed in m/min. Divide MASTER_SPEED_PCT by 100 and multiply to get actual m/min"
  },

  // ─── EXTRUDER ─────────────────────────────────────────────────────────────
  EXTRUDER_ON_OFF: {
    addr: 101, type: "bool", fc: 1,
    label: "Extruder ON/OFF", unit: "", subsystem: "Extruder",
    warn_hi: null, warn_lo: null, alarm_hi: null, alarm_lo: null
  },
  EXTRUDER_FWD: {
    addr: 110, type: "bool", fc: 1,
    label: "Extruder Forward", unit: "", subsystem: "Extruder",
    warn_hi: null, warn_lo: null, alarm_hi: null, alarm_lo: null
  },
  EXTRUDER_REV: {
    addr: 111, type: "bool", fc: 1,
    label: "Extruder Reverse", unit: "", subsystem: "Extruder",
    warn_hi: null, warn_lo: null, alarm_hi: null, alarm_lo: null
  },
  EXTRUDER_FWD_IND: {
    addr: 160, type: "bool", fc: 1,
    label: "Extruder Fwd Indicator", unit: "", subsystem: "Extruder",
    warn_hi: null, warn_lo: null, alarm_hi: null, alarm_lo: null, readonly: true
  },
  EXTRUDER_REV_IND: {
    addr: 161, type: "bool", fc: 1,
    label: "Extruder Rev Indicator", unit: "", subsystem: "Extruder",
    warn_hi: null, warn_lo: null, alarm_hi: null, alarm_lo: null, readonly: true
  },
  EXTRUDER_FAULT: {
    addr: 13, type: "bool", fc: 1,
    label: "Extruder Fault", unit: "", subsystem: "Extruder",
    warn_hi: null, warn_lo: null, alarm_hi: null, alarm_lo: null, readonly: true
  },
  EXTRUDER_SPEED_PCT: {
    addr: 400002, type: "uint16", fc: 3,
    label: "Extruder Speed", unit: "%", subsystem: "Extruder",
    warn_hi: 95, warn_lo: 5, alarm_hi: 100, alarm_lo: 0
  },
  EXTRUDER_RPM: {
    addr: 401105, type: "float", fc: 3,
    label: "Extruder RPM", unit: "RPM", subsystem: "Extruder",
    warn_hi: 80, warn_lo: 5, alarm_hi: 100, alarm_lo: 0,
    readonly: true
  },
  EXTRUDER_MAX_RPM: {
    addr: 400025, type: "float", fc: 3,
    label: "Extruder Max RPM", unit: "RPM", subsystem: "Extruder",
    warn_hi: null, warn_lo: null, alarm_hi: null, alarm_lo: null,
    readonly: true,
    description: "Configured max RPM ceiling for EXTRUDER_RPM"
  },
  EXTRUDER_AMP: {
    addr: 401109, type: "float", fc: 3,
    label: "Extruder Amps", unit: "A", subsystem: "Extruder",
    warn_hi: 35, warn_lo: null, alarm_hi: 40, alarm_lo: null,
    readonly: true
  },
  EXTRUDER_SPEED_VOL: {
    addr: 401201, type: "float", fc: 3,
    label: "Extruder Speed Voltage", unit: "V", subsystem: "Extruder",
    warn_hi: null, warn_lo: null, alarm_hi: null, alarm_lo: null,
    readonly: true,
    description: "Raw analog speed reference voltage — diagnostic use only, not for operator display"
  },
  EXTRUDER_FWD_REV_ELR_FAULT: {
    addr: 63497, type: "bool", fc: 1,
    label: "Extruder FWD/REV SSR Fault", unit: "", subsystem: "Extruder",
    warn_hi: null, warn_lo: null, alarm_hi: null, alarm_lo: null,
    readonly: true,
    description: "X10 input bit — solid state relay fault for extruder direction"
  },

  // ─── LAMINATOR ────────────────────────────────────────────────────────────
  LAMINATOR_ON_OFF: {
    addr: 102, type: "bool", fc: 1,
    label: "Laminator ON/OFF", unit: "", subsystem: "Laminator",
    warn_hi: null, warn_lo: null, alarm_hi: null, alarm_lo: null
  },
  LAMINATOR_FAULT: {
    addr: 14, type: "bool", fc: 1,
    label: "Laminator Fault", unit: "", subsystem: "Laminator",
    warn_hi: null, warn_lo: null, alarm_hi: null, alarm_lo: null, readonly: true
  },
  LAMINATOR_UP: {
    addr: 116, type: "bool", fc: 1,
    label: "Laminator Up Command", unit: "", subsystem: "Laminator",
    warn_hi: null, warn_lo: null, alarm_hi: null, alarm_lo: null
  },
  LAMINATOR_DOWN: {
    addr: 117, type: "bool", fc: 1,
    label: "Laminator Down Command", unit: "", subsystem: "Laminator",
    warn_hi: null, warn_lo: null, alarm_hi: null, alarm_lo: null
  },
  LAMINATOR_UP_IND: {
    addr: 162, type: "bool", fc: 1,
    label: "Laminator Raised (Indicator)", unit: "", subsystem: "Laminator",
    warn_hi: null, warn_lo: null, alarm_hi: null, alarm_lo: null, readonly: true
  },
  LAMINATOR_DOWN_IND: {
    addr: 163, type: "bool", fc: 1,
    label: "Laminator Lowered (Indicator)", unit: "", subsystem: "Laminator",
    warn_hi: null, warn_lo: null, alarm_hi: null, alarm_lo: null, readonly: true
  },
  LAMINATOR_RUBBER_ROLL_OPEN: {
    addr: 106, type: "bool", fc: 1,
    label: "Rubber Roll Open", unit: "", subsystem: "Laminator",
    warn_hi: null, warn_lo: null, alarm_hi: null, alarm_lo: null,
    description: "Rubber roll retracted — no lamination contact"
  },
  LAMINATOR_RUBBER_ROLL_CLOSE: {
    addr: 107, type: "bool", fc: 1,
    label: "Rubber Roll Closed", unit: "", subsystem: "Laminator",
    warn_hi: null, warn_lo: null, alarm_hi: null, alarm_lo: null,
    description: "Rubber roll engaged — lamination contact active"
  },
  LAMINATOR_SPEED_PCT: {
    addr: 400003, type: "uint16", fc: 3,
    label: "Laminator Speed", unit: "%", subsystem: "Laminator",
    warn_hi: 95, warn_lo: 5, alarm_hi: 100, alarm_lo: 0
  },
  LAMINATOR_MPM: {
    addr: 401107, type: "float", fc: 3,
    label: "Laminator Speed", unit: "m/min", subsystem: "Laminator",
    warn_hi: 130, warn_lo: 5, alarm_hi: 150, alarm_lo: 0,
    readonly: true
  },
  LAMINATOR_MAX_RPM: {
    addr: 400027, type: "float", fc: 3,
    label: "Laminator Max RPM", unit: "RPM", subsystem: "Laminator",
    warn_hi: null, warn_lo: null, alarm_hi: null, alarm_lo: null,
    readonly: true,
    description: "Configured max RPM ceiling for laminator drive"
  },
  LAMINATOR_AMP: {
    addr: 401111, type: "float", fc: 3,
    label: "Laminator Amps", unit: "A", subsystem: "Laminator",
    warn_hi: 12, warn_lo: null, alarm_hi: 15, alarm_lo: null,
    readonly: true
  },
  LAMINATOR_ROLL_DIA: {
    addr: 400221, type: "float", fc: 3,
    label: "Laminator Roll Diameter", unit: "mm", subsystem: "Laminator",
    warn_hi: null, warn_lo: null, alarm_hi: null, alarm_lo: null,
    readonly: true,
    description: "Used in MPM calculation — context for interpreting speed values"
  },
  LAMINATOR_SPEED_VOL: {
    addr: 401203, type: "float", fc: 3,
    label: "Laminator Speed Voltage", unit: "V", subsystem: "Laminator",
    warn_hi: null, warn_lo: null, alarm_hi: null, alarm_lo: null,
    readonly: true,
    description: "Raw analog speed reference voltage — diagnostic use only"
  },
  LAMINATOR_UP_DOWN_ELR_FAULT: {
    addr: 63498, type: "bool", fc: 1,
    label: "Laminator Up/Down SSR Fault", unit: "", subsystem: "Laminator",
    warn_hi: null, warn_lo: null, alarm_hi: null, alarm_lo: null,
    readonly: true,
    description: "X11 input bit — SSR fault for laminator vertical movement"
  },

  // ─── WINDER ───────────────────────────────────────────────────────────────
  WINDER_ON_OFF: {
    addr: 103, type: "bool", fc: 1,
    label: "Winder ON/OFF", unit: "", subsystem: "Winder",
    warn_hi: null, warn_lo: null, alarm_hi: null, alarm_lo: null
  },
  WINDER_FAULT: {
    addr: 15, type: "bool", fc: 1,
    label: "Winder Fault", unit: "", subsystem: "Winder",
    warn_hi: null, warn_lo: null, alarm_hi: null, alarm_lo: null, readonly: true
  },
  WINDER_DANCER_MODE: {
    addr: 613, type: "bool", fc: 1,
    label: "Winder Dancer Mode", unit: "", subsystem: "Winder",
    warn_hi: null, warn_lo: null, alarm_hi: null, alarm_lo: null,
    description: "ON = dancer roll tension control; OFF = torque/speed control"
  },
  CONTACT_WINDER: {
    addr: 528, type: "bool", fc: 1,
    label: "Contact Winder Mode", unit: "", subsystem: "Winder",
    warn_hi: null, warn_lo: null, alarm_hi: null, alarm_lo: null,
    description: "ON = contact winder (lay-on roll active); affects roll hardness at high speed"
  },
  WINDER_TENSION_PCT: {
    addr: 400004, type: "uint16", fc: 3,
    label: "Winder Tension", unit: "%", subsystem: "Winder",
    warn_hi: 80, warn_lo: 10, alarm_hi: 90, alarm_lo: 5
  },
  WINDER_AMP: {
    addr: 401113, type: "float", fc: 3,
    label: "Winder Amps", unit: "A", subsystem: "Winder",
    warn_hi: 8, warn_lo: null, alarm_hi: 12, alarm_lo: null,
    readonly: true
  },
  WINDER_TENSION_VOL: {
    addr: 401041, type: "float", fc: 3,
    label: "Winder Tension Voltage", unit: "V", subsystem: "Winder",
    warn_hi: null, warn_lo: null, alarm_hi: null, alarm_lo: null,
    readonly: true,
    description: "Raw analog tension voltage — diagnostic use only"
  },

  // ─── UNWINDER (Main) ──────────────────────────────────────────────────────
  UW_SET_TENSION: {
    addr: 403503, type: "uint16", fc: 3,
    label: "Unwinder Set Tension", unit: "counts", subsystem: "Unwinder",
    warn_hi: null, warn_lo: null, alarm_hi: null, alarm_lo: null,
    description: "Tension setpoint in raw loadcell counts"
  },
  UW_PV_TENSION: {
    addr: 403881, type: "uint16", fc: 3,
    label: "Unwinder Actual Tension (Filtered)", unit: "counts", subsystem: "Unwinder",
    warn_hi: null, warn_lo: null, alarm_hi: null, alarm_lo: null,
    readonly: true,
    description: "Filtered loadcell reading — use this for operator display and trend"
  },
  UW_PV_TENSION_RAW: {
    addr: 400149, type: "uint16", fc: 3,
    label: "Unwinder Actual Tension (Raw)", unit: "counts", subsystem: "Unwinder",
    warn_hi: null, warn_lo: null, alarm_hi: null, alarm_lo: null,
    readonly: true,
    description: "Unfiltered loadcell — use for fault diagnosis only"
  },
  UW_BREAK_CHANGE_MPM: {
    addr: 401141, type: "float", fc: 3,
    label: "Unwinder Brake Changeover Speed", unit: "m/min", subsystem: "Unwinder",
    warn_hi: null, warn_lo: null, alarm_hi: null, alarm_lo: null,
    description: "Line speed at which UW brake control transitions mode"
  },
  UW_MANUAL_SET: {
    addr: 133, type: "bool", fc: 1,
    label: "Unwinder Manual Mode", unit: "", subsystem: "Unwinder",
    warn_hi: null, warn_lo: null, alarm_hi: null, alarm_lo: null
  },
  UW_AUTO_SET: {
    addr: 134, type: "bool", fc: 1,
    label: "Unwinder Auto Mode", unit: "", subsystem: "Unwinder",
    warn_hi: null, warn_lo: null, alarm_hi: null, alarm_lo: null
  },
  UW_WEB_ALIGNER: {
    addr: 109, type: "bool", fc: 1,
    label: "Main Web Aligner ON/OFF", unit: "", subsystem: "Unwinder",
    warn_hi: null, warn_lo: null, alarm_hi: null, alarm_lo: null
  },
  UW_WEB_ALIGNER_FAULT: {
    addr: 63500, type: "bool", fc: 1,
    label: "Unwinder Web Aligner Fault", unit: "", subsystem: "Unwinder",
    warn_hi: null, warn_lo: null, alarm_hi: null, alarm_lo: null,
    readonly: true,
    description: "X13 input bit"
  },

  // ─── SANDWICH UNWINDER ────────────────────────────────────────────────────
  SANDWICH_UW_ENABLE: {
    addr: 521, type: "bool", fc: 1,
    label: "Sandwich Unwinder Enable", unit: "", subsystem: "SandwichUnwinder",
    warn_hi: null, warn_lo: null, alarm_hi: null, alarm_lo: null,
    description: "ON = second film layer active. If OFF, sandwich lamination is not running"
  },
  SUW_SET_TENSION: {
    addr: 401853, type: "uint16", fc: 3,
    label: "Sandwich UW Set Tension", unit: "counts", subsystem: "SandwichUnwinder",
    warn_hi: null, warn_lo: null, alarm_hi: null, alarm_lo: null
  },
  SUW_PV_TENSION: {
    addr: 401831, type: "uint16", fc: 3,
    label: "Sandwich UW Actual Tension (Filtered)", unit: "counts", subsystem: "SandwichUnwinder",
    warn_hi: null, warn_lo: null, alarm_hi: null, alarm_lo: null,
    readonly: true
  },
  SUW_MANUAL_SET: {
    addr: 136, type: "bool", fc: 1,
    label: "Sandwich UW Manual Mode", unit: "", subsystem: "SandwichUnwinder",
    warn_hi: null, warn_lo: null, alarm_hi: null, alarm_lo: null
  },
  SUW_AUTO_SET: {
    addr: 135, type: "bool", fc: 1,
    label: "Sandwich UW Auto Mode", unit: "", subsystem: "SandwichUnwinder",
    warn_hi: null, warn_lo: null, alarm_hi: null, alarm_lo: null
  },

  // ─── HOTPLATE ─────────────────────────────────────────────────────────────
  // Note: M521 is named HOTPLATE_ENABLE but PLC coil offset is 522
  //       M181 is named HOTPLATE_CLOSE but PLC coil offset is 182 (naming error in HMI)
  HOTPLATE_ENABLE: {
    addr: 522, type: "bool", fc: 1,
    label: "Hotplate Enable", unit: "", subsystem: "Hotplate",
    warn_hi: null, warn_lo: null, alarm_hi: null, alarm_lo: null,
    description: "Master enable for unwinder hotplate subsystem"
  },
  HOTPLATE_OPEN: {
    addr: 181, type: "bool", fc: 1,
    label: "Hotplate Open", unit: "", subsystem: "Hotplate",
    warn_hi: null, warn_lo: null, alarm_hi: null, alarm_lo: null,
    description: "Hotplate retracted away from substrate"
  },
  HOTPLATE_CLOSE: {
    addr: 182, type: "bool", fc: 1,           // offset 182, NOT 181 — HMI naming error
    label: "Hotplate Closed", unit: "", subsystem: "Hotplate",
    warn_hi: null, warn_lo: null, alarm_hi: null, alarm_lo: null,
    description: "Hotplate in contact with substrate"
  },
  HOTPLATE_AUTO_CLOSE_ENABLE: {
    addr: 523, type: "bool", fc: 1,
    label: "Hotplate Auto-Close Enable", unit: "", subsystem: "Hotplate",
    warn_hi: null, warn_lo: null, alarm_hi: null, alarm_lo: null,
    description: "When ON, hotplate closes automatically when line speed exceeds HOTPLATE_AUTO_CLOSE_MPM"
  },
  HOTPLATE_AUTO_CLOSE_MPM: {
    addr: 402051, type: "float", fc: 3,
    label: "Hotplate Auto-Close Speed", unit: "m/min", subsystem: "Hotplate",
    warn_hi: null, warn_lo: null, alarm_hi: null, alarm_lo: null,
    description: "Speed setpoint above which hotplate auto-closes during startup"
  },
  HEATING_PANEL_MCCB_TRIP: {
    addr: 63520, type: "bool", fc: 1,
    label: "Heating Panel MCCB Trip", unit: "", subsystem: "Hotplate",
    warn_hi: null, warn_lo: null, alarm_hi: null, alarm_lo: null,
    readonly: true,
    description: "X37 input — heater panel main circuit breaker tripped"
  },

  // ─── PRODUCTION ───────────────────────────────────────────────────────────
  RUNNING_METER: {
    addr: 400009, type: "float", fc: 3,
    label: "Running Meter", unit: "m", subsystem: "Production",
    warn_hi: null, warn_lo: null, alarm_hi: null, alarm_lo: null,
    readonly: true,
    description: "Cumulative meters for current roll — resets on METER_RESET"
  },
  TOTAL_METER: {
    addr: 400011, type: "float", fc: 3,
    label: "Total Meter", unit: "m", subsystem: "Production",
    warn_hi: null, warn_lo: null, alarm_hi: null, alarm_lo: null,
    readonly: true,
    description: "Lifetime cumulative meters"
  },
  METER_ROLL_DIA: {
    addr: 400007, type: "float", fc: 3,
    label: "Meter Roll Diameter", unit: "mm", subsystem: "Production",
    warn_hi: null, warn_lo: null, alarm_hi: null, alarm_lo: null
  },
  GSM_ENTRY: {
    addr: 401301, type: "float", fc: 3,
    label: "GSM Entry", unit: "g/m²", subsystem: "Production",
    warn_hi: null, warn_lo: null, alarm_hi: null, alarm_lo: null,
    description: "Set GSM target — thresholds depend on product spec"
  },
  GRAM_ENTRY: {
    addr: 403005, type: "float", fc: 3,
    label: "Gram Entry", unit: "g", subsystem: "Production",
    warn_hi: null, warn_lo: null, alarm_hi: null, alarm_lo: null
  },
  FABRIC_SIZE: {
    addr: 401297, type: "float", fc: 3,
    label: "Fabric Width", unit: "mm", subsystem: "Production",
    warn_hi: null, warn_lo: null, alarm_hi: null, alarm_lo: null,
    description: "Fabric width — context for GSM/gram calculation"
  },
  GSM_SELECTION: {
    addr: 635, type: "bool", fc: 1,
    label: "GSM Mode Active", unit: "", subsystem: "Production",
    warn_hi: null, warn_lo: null, alarm_hi: null, alarm_lo: null,
    description: "ON = machine running in GSM control mode"
  },
  GRAM_LOGIC_SELECTION: {
    addr: 901, type: "bool", fc: 1,
    label: "Gram Logic Mode Active", unit: "", subsystem: "Production",
    warn_hi: null, warn_lo: null, alarm_hi: null, alarm_lo: null,
    description: "ON = machine running in gram control mode"
  },
  GRAM_ENABLE: {
    addr: 636, type: "bool", fc: 1,
    label: "Gram Enable", unit: "", subsystem: "Production",
    warn_hi: null, warn_lo: null, alarm_hi: null, alarm_lo: null
  },
  GRAM_APPLY: {
    addr: 3003, type: "bool", fc: 1,
    label: "Gram Apply", unit: "", subsystem: "Production",
    warn_hi: null, warn_lo: null, alarm_hi: null, alarm_lo: null
  },
  SET_RPM_FOR_GRAM: {
    addr: 403001, type: "float", fc: 3,
    label: "RPM Setpoint for Gram Control", unit: "RPM", subsystem: "Production",
    warn_hi: null, warn_lo: null, alarm_hi: null, alarm_lo: null
  },

  // ─── SPLICE ───────────────────────────────────────────────────────────────
  SPLICE_ON_OFF: {
    addr: 112, type: "bool", fc: 1,
    label: "Splice ON/OFF", unit: "", subsystem: "Splice",
    warn_hi: null, warn_lo: null, alarm_hi: null, alarm_lo: null
  },
  SPLICE_SPEED: {
    addr: 400019, type: "uint16", fc: 3,
    label: "Splice Speed", unit: "%", subsystem: "Splice",
    warn_hi: null, warn_lo: null, alarm_hi: null, alarm_lo: null,
    description: "Speed during splice sequence as % of max"
  },
  SPLICE_ACC_TIME: {
    addr: 400020, type: "uint16", fc: 3,
    label: "Splice Acceleration Time", unit: "s", subsystem: "Splice",
    warn_hi: null, warn_lo: null, alarm_hi: null, alarm_lo: null
  },
  SPLICE_DCC_TIME: {
    addr: 400021, type: "uint16", fc: 3,
    label: "Splice Deceleration Time", unit: "s", subsystem: "Splice",
    warn_hi: null, warn_lo: null, alarm_hi: null, alarm_lo: null
  },

  // ─── SAFETY & ALARMS ──────────────────────────────────────────────────────
  EMG_STOP: {
    addr: 10, type: "bool", fc: 1,
    label: "Emergency Stop", unit: "", subsystem: "Safety",
    warn_hi: null, warn_lo: null, alarm_hi: null, alarm_lo: null,
    readonly: true,
    description: "M9 bit — active HIGH means emergency stop engaged"
  },
  ALARM_IND: {
    addr: 126, type: "bool", fc: 1,
    label: "Alarm Indicator", unit: "", subsystem: "Safety",
    warn_hi: null, warn_lo: null, alarm_hi: null, alarm_lo: null,
    readonly: true
  },
  ALARM_RESET: {
    addr: 53, type: "bool", fc: 1,
    label: "Alarm Reset", unit: "", subsystem: "Safety",
    warn_hi: null, warn_lo: null, alarm_hi: null, alarm_lo: null
  },
  LOGIC_ENABLE: {
    addr: 621, type: "bool", fc: 1,
    label: "Logic Enable", unit: "", subsystem: "Safety",
    warn_hi: null, warn_lo: null, alarm_hi: null, alarm_lo: null,
    description: "Master logic gate — if OFF, machine drives are inhibited even if ON/OFF bits are set"
  },
  AIR_PRESSURE_LOW: {
    addr: 63494, type: "bool", fc: 1,
    label: "Air Pressure Low", unit: "", subsystem: "Safety",
    warn_hi: null, warn_lo: null, alarm_hi: null, alarm_lo: null,
    readonly: true,
    description: "X5 input — pneumatic supply below threshold. Affects nip pressure and laminator movement"
  },
  TRIM_BLOWER_ON_OFF: {
    addr: 108, type: "bool", fc: 1,
    label: "Trim Blower ON/OFF", unit: "", subsystem: "Safety",
    warn_hi: null, warn_lo: null, alarm_hi: null, alarm_lo: null
  },
  TRIM_BLOWER_FAULT: {
    addr: 63499, type: "bool", fc: 1,
    label: "Trim Blower Fault", unit: "", subsystem: "Safety",
    warn_hi: null, warn_lo: null, alarm_hi: null, alarm_lo: null,
    readonly: true,
    description: "X12 input bit"
  },

  // ─── PLC DIAGNOSTICS ──────────────────────────────────────────────────────
  PLC_RUN: {
    addr: 8001, type: "bool", fc: 1,
    label: "PLC Running", unit: "", subsystem: "PLC",
    warn_hi: null, warn_lo: null, alarm_hi: null, alarm_lo: null,
    readonly: true,
    description: "M8000 — ON when PLC scan is active"
  },
  PLC_ERROR_IND: {
    addr: 8005, type: "bool", fc: 1,
    label: "PLC Error", unit: "", subsystem: "PLC",
    warn_hi: null, warn_lo: null, alarm_hi: null, alarm_lo: null,
    readonly: true
  },
  PLC_BATTERY_LOW: {
    addr: 8006, type: "bool", fc: 1,
    label: "PLC Battery Low", unit: "", subsystem: "PLC",
    warn_hi: null, warn_lo: null, alarm_hi: null, alarm_lo: null,
    readonly: true
  },

  // ─── SPARE ANALOG INPUTS (for future temperature wiring) ─────────────────
  // These are 4AD-1 module channels — wired to IREG (FC4)
  // 4–20mA from external temperature controllers can be wired here
  SPARE_ANALOG_CH1: {
    addr: 313289, type: "int16", fc: 4,
    label: "Spare Analog CH1 (4AD-1)", unit: "counts", subsystem: "Spare",
    warn_hi: null, warn_lo: null, alarm_hi: null, alarm_lo: null,
    readonly: true,
    description: "Available for die zone temperature 4-20mA input"
  },
  SPARE_ANALOG_CH2: {
    addr: 313290, type: "int16", fc: 4,
    label: "Spare Analog CH2 (4AD-1)", unit: "counts", subsystem: "Spare",
    warn_hi: null, warn_lo: null, alarm_hi: null, alarm_lo: null,
    readonly: true,
    description: "Available for barrel temperature 4-20mA input"
  },
};
3. Agent Code Fixes (agent.ts)
3.1 Fix decomposeComplexQuery — wrong tag name
// BEFORE (broken — tag doesn't exist):
{ question: "Were there tension anomalies?", tool: "get_tag_history", args: { tag: "WINDER_TENSION" } }

// AFTER (correct):
{ question: "Were there tension anomalies?", tool: "get_tag_history", args: { tag: "WINDER_TENSION_PCT" } }
3.2 Fix inferUnit — boolean tags and raw-count tension tags
function inferUnit(tag: string): string {
  const t = tag.toUpperCase();
  // Raw voltage — never label as engineering unit
  if (t.includes("_VOL") || t.endsWith("_V")) return "V";
  // Raw loadcell counts — not %
  if (t.includes("UW_PV") || t.includes("SUW_PV") ||
      t.includes("UW_SET") || t.includes("SUW_SET")) return "counts";
  if (t.includes("PCT") || t.includes("PERCENT") || t.includes("EFFICIENCY")) return "%";
  if (t.includes("MPM")) return "m/min";
  if (t.includes("RPM")) return "RPM";
  if (t.includes("GSM")) return "g/m²";
  if (t.includes("TEMP") || t.includes("°C")) return "°C";
  if (t.includes("TENSION_PCT") || t.includes("WINDER_TENSION")) return "%";
  if (t.includes("METER") && !t.includes("MPM")) return "m";
  if (t.includes("AMP")) return "A";
  return "";
}
3.3 Fix shouldGenerateChart — exclude boolean tags
function shouldGenerateChart(userMessage: string, toolSteps: AgentToolStep[]): boolean {
  const m = userMessage.toLowerCase();
  const wantsChart =
    m.includes("trend") || m.includes("history") || m.includes("over time") ||
    m.includes("graph") || m.includes("chart") || m.includes("plot") ||
    m.includes("past") || m.includes("compare");

  if (!wantsChart) return false;

  // Don't generate chart if only boolean tags were fetched
  const historySteps = toolSteps.filter(s => s.tool === "get_tag_history" && s.status === "success");
  const hasNumericData = historySteps.some(s => {
    const samples = s.result?.samples ?? [];
    return samples.length >= 2 && samples.some((d: any) => {
      const v = Number(d.value ?? d.val ?? NaN);
      return !isNaN(v) && v !== 0 && v !== 1;
    });
  });

  return hasNumericData;
}
// Update call site in runGeminiAgent:
// const charts = shouldGenerateChart(args.userMessage, result.toolSteps) ? ...
3.4 Fix system prompt — add missing subsystems
In SYSTEM_PROMPT, update the subsystems line:

// BEFORE:
Subsystems: Extruder, Laminator, Winder, Unwinder, Splice, Production, Safety.

// AFTER:
Subsystems: Extruder, Laminator, Winder, Unwinder (Main + Sandwich), Hotplate,
            Splice, Production, Safety, PLC.

// Add to SECTION 1 classification triggers (CURRENT):
  → Also use: HOTPLATE_ENABLE, HOTPLATE_CLOSE, SANDWICH_UW_ENABLE, CONTACT_WINDER,
    LOGIC_ENABLE, GSM_SELECTION, GRAM_LOGIC_SELECTION for mode/state queries

// Add to SECTION 5 tag name plain-English mapping:
    HOTPLATE_CLOSE / HOTPLATE_OPEN → hotplate position
    SANDWICH_UW_ENABLE             → second film layer
    CONTACT_WINDER                 → contact winder mode
    WINDER_DANCER_MODE             → dancer roll tension mode
    GSM_SELECTION                  → GSM control mode active
    GRAM_LOGIC_SELECTION           → gram control mode active
    LOGIC_ENABLE                   → machine logic gate
    AIR_PRESSURE_LOW               → air pressure fault
    MACHINE_MAX_LINE_SPEED         → maximum line speed (m/min)
    EXTRUDER_MAX_RPM               → extruder RPM ceiling
    LAMINATOR_MAX_RPM              → laminator RPM ceiling
3.5 Fix historical query plan leaking present-state tool
// In buildHeuristicPlan, historical branch — remove the default alert fallback:
} else if (queryClass === "historical") {
  push("get_alert_history", "Load alerts in the requested time window");
  push("get_tag_history", "Load primary tag values in the window (speed, meter, RPM)");
  // DO NOT add get_active_alerts here — it's a present-state tool
3.6 Add derived speed calculation utility
// Add to agent.ts — used in answer construction and tool response enrichment
export function computeActualSpeed(
  masterSpeedPct: number,
  machineMaxSpeed: number
): number {
  return Math.round((masterSpeedPct / 100) * machineMaxSpeed * 10) / 10;
}

// The AI should use this when both MASTER_SPEED_PCT and MACHINE_MAX_LINE_SPEED
// are available in tool results, e.g.:
// "Line speed is 82% = 98.4 m/min (max: 120 m/min, headroom: 21.6 m/min)"
4. Temperature Monitoring — Implementation Path
Since zero temperature tags exist in the PLC, two options in priority order:

Option A — Immediate (no PLC change): Wire to spare 4AD-1 channels
Run 4–20mA signal wire from temperature controller analog output → terminal block of 4AD-1 module on spare CH1 and CH2.
Read SPARE_ANALOG_CH1 (addr 313289, FC4) and SPARE_ANALOG_CH2 (addr 313290, FC4).
Scale raw count to °C using linear formula: temp = (raw / 4000) * (max_temp - min_temp) + min_temp (confirm scale range from temp controller manual).
Add DIE_TEMP and BARREL_TEMP as tags after confirming scale:
DIE_TEMP: {
  addr: 313289, type: "int16", fc: 4,
  label: "Die Temperature", unit: "°C", subsystem: "Extruder",
  warn_hi: 220, warn_lo: 160, alarm_hi: 240, alarm_lo: 140,
  readonly: true,
  description: "4AD-1 CH1 — scaled from 4-20mA temperature controller output"
},
BARREL_TEMP: {
  addr: 313290, type: "int16", fc: 4,
  label: "Barrel Temperature", unit: "°C", subsystem: "Extruder",
  warn_hi: 220, warn_lo: 160, alarm_hi: 240, alarm_lo: 140,
  readonly: true,
  description: "4AD-1 CH2 — scaled from 4-20mA temperature controller output"
},
Option B — Proper (requires PLC change): Modbus RTU from temp controllers to PLC
Connect temperature controller RS485 port to PLC RS485 port (confirm controller has Modbus RTU slave capability).
Write PLC ladder to read zone temperatures into D-registers on a 1-second poll.
Those D-registers become HREG tags readable via Modbus TCP as usual.
5. Production Increase — Operator Guidance the AI Can Now Give
With the patched tags, the agent can now answer:

Operator Question	Tags Now Available
"How fast can I push the line?"	MASTER_SPEED_PCT + MACHINE_MAX_LINE_SPEED → actual m/min + headroom
"Is the hotplate on?"	HOTPLATE_ENABLE + HOTPLATE_CLOSE
"Why is lamination bad on startup?"	HOTPLATE_AUTO_CLOSE_MPM + HOTPLATE_AUTO_CLOSE_ENABLE
"Is the second film layer running?"	SANDWICH_UW_ENABLE + SUW_PV_TENSION
"What tension control mode is active?"	WINDER_DANCER_MODE + PID_SELECTION
"Is the rubber roll engaged?"	LAMINATOR_RUBBER_ROLL_CLOSE
"Is the machine in GSM or gram mode?"	GSM_SELECTION + GRAM_LOGIC_SELECTION
"Is air pressure okay?"	AIR_PRESSURE_LOW
"Is the logic gate enabled?"	LOGIC_ENABLE
"Is the extruder near its RPM limit?"	EXTRUDER_RPM + EXTRUDER_MAX_RPM
6. Patch Checklist
[ ] Replace TAGS config with patched version (Section 2)
[ ] Fix decomposeComplexQuery — WINDER_TENSION → WINDER_TENSION_PCT (Section 3.1)
[ ] Fix inferUnit — raw counts and voltage tags (Section 3.2)
[ ] Fix shouldGenerateChart — exclude boolean-only history (Section 3.3)
[ ] Update system prompt subsystem list + tag plain-English mapping (Section 3.4)
[ ] Remove get_active_alerts from historical query plan (Section 3.5)
[ ] Add computeActualSpeed utility (Section 3.6)
[ ] Wire temperature controller 4–20mA to 4AD-1 CH1/CH2 (Section 4 Option A)
[ ] Confirm and add warn_lo/alarm_lo for GSM_ENTRY and GRAM_ENTRY once product spec thresholds are known
[ ] Note coil address discrepancy: HOTPLATE_CLOSE tag named M181 but PLC offset is 182