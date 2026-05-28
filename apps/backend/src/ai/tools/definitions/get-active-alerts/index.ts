import { getActiveAlertsSchema } from "./schema.js";
import { execute } from "./handler.js";

export const tool = {
  name: "get_active_alerts",
  description: "Present-state alerts. Prefer this for 'what is wrong', 'any issues', 'status'. Default status=open.",
  schema: getActiveAlertsSchema,
  execute,
  metadata: {
    category: "alerts" as const,
    freshness: "live" as const,
    expensive: false
  }
};
