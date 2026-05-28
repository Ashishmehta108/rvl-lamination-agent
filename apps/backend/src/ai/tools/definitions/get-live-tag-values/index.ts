import { getLiveTagValuesSchema } from "./schema.js";
import { execute } from "./handler.js";

export const tool = {
  name: "get_live_tag_values",
  description: "Fetch current values for one or more tags.",
  schema: getLiveTagValuesSchema,
  execute,
  metadata: {
    category: "tags" as const,
    freshness: "live" as const,
    expensive: false
  }
};
