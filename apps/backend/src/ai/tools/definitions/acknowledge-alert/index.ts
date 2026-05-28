import { acknowledgeAlertSchema } from "./schema.js";
import { execute } from "./handler.js";

export const tool = {
  name: "acknowledge_alert",
  description: "Acknowledge an open alert event.",
  schema: acknowledgeAlertSchema,
  execute,
  metadata: {
    category: "alerts" as const,
    freshness: "write" as const,
    expensive: false
  }
};
