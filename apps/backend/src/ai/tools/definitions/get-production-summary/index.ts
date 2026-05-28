import { getProductionSummarySchema } from "./schema.js";
import { execute } from "./handler.js";

export const tool = {
  name: "get_production_summary",
  description: "Get current production metrics and efficiency stats.",
  schema: getProductionSummarySchema,
  execute,
  metadata: {
    category: "production" as const,
    freshness: "live" as const,
    expensive: false
  }
};
