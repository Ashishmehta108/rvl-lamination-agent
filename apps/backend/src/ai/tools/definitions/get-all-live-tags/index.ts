import { getAllLiveTagsSchema } from "./schema.js";
import { execute } from "./handler.js";

export const tool = {
  name: "get_all_live_tags",
  description: "Fetch all current tag values for the machine grouped by subsystem.",
  schema: getAllLiveTagsSchema,
  execute,
  metadata: {
    category: "tags" as const,
    freshness: "live" as const,
    expensive: false
  }
};
