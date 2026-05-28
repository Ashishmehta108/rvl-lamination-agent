export type TagDefinitionRecord = {
  id: string;
  machineId: string;
  machineRevision: string;
  tagId: string;
  slug: string;
  name: string;
  unit: string | null;
  dataType: string;
  deadband: number | null;
  min: number | null;
  max: number | null;
  maxRatePerSec: number | null;
  sampleEveryMs: number | null;
  staleAfterMs: number | null;
  warnHigh: number | null;
  warnLow: number | null;
  alarmHigh: number | null;
  alarmLow: number | null;
  department: string | null;
  engineerEmail: string | null;
  createdAt: Date;
  updatedAt: Date;
};

export type TagLatestRecord = {
  tagId: string;
  ts: Date;
  valueNumber: number | null;
  valueBool: boolean | null;
  valueString: string | null;
  quality: string;
  lastSampleAt: Date | null;
  updatedAt: Date;
};

export const TOOL_NAMES = [
  "get_live_tag_values",
  "get_all_live_tags",
  "get_tag_history",
  "get_active_alerts",
  "get_alert_history",
  "get_tag_definition",
  "get_production_summary",
  "search_tags",
  "get_machine_status",
  "acknowledge_alert",
  "get_chat_sessions",
  "get_tag_comparison",
] as const;

export type ToolName = (typeof TOOL_NAMES)[number];