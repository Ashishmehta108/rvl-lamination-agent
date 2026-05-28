import { tool as getLiveTagValues } from "./definitions/get-live-tag-values/index.js";
import { tool as getAllLiveTags } from "./definitions/get-all-live-tags/index.js";
import { tool as getTagHistory } from "./definitions/get-tag-history/index.js";
import { tool as getActiveAlerts } from "./definitions/get-active-alerts/index.js";
import { tool as getAlertHistory } from "./definitions/get-alert-history/index.js";
import { tool as getTagDefinition } from "./definitions/get-tag-definition/index.js";
import { tool as getProductionSummary } from "./definitions/get-production-summary/index.js";
import { tool as searchTags } from "./definitions/search-tags/index.js";
import { tool as getMachineStatus } from "./definitions/get-machine-status/index.js";
import { tool as acknowledgeAlert } from "./definitions/acknowledge-alert/index.js";
import { tool as getChatSessions } from "./definitions/get-chat-sessions/index.js";
import { tool as getTagComparison } from "./definitions/get-tag-comparison/index.js";

export const toolRegistry = {
  get_live_tag_values:   getLiveTagValues,
  get_all_live_tags:     getAllLiveTags,
  get_tag_history:       getTagHistory,
  get_active_alerts:     getActiveAlerts,
  get_alert_history:     getAlertHistory,
  get_tag_definition:    getTagDefinition,
  get_production_summary: getProductionSummary,
  search_tags:           searchTags,
  get_machine_status:    getMachineStatus,
  acknowledge_alert:     acknowledgeAlert,
  get_chat_sessions:     getChatSessions,
  get_tag_comparison:    getTagComparison,
} as const;

export type ToolRegistry = typeof toolRegistry;