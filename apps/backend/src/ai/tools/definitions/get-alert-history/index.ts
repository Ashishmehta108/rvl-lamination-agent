import { getAlertHistorySchema } from "./schema.js";
import { execute } from "./handler.js";

export const tool = {
  name: "get_alert_history",
  description: "Historical alerts for an explicit time window only.",
  schema: getAlertHistorySchema,
  execute,
  metadata: {
    category: "alerts" as const,
    freshness: "history" as const,
    expensive: true
  }
};
