import { getTagHistorySchema } from "./schema.js";
import { execute } from "./handler.js";

export const tool = {
  name: "get_tag_history",
  description: "Fetch time-series samples for a tag.",
  schema: getTagHistorySchema,
  execute,
  metadata: {
    category: "tags" as const,
    freshness: "history" as const,
    expensive: true
  }
};
