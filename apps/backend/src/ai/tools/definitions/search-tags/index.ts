import { searchTagsSchema } from "./schema.js";
import { execute } from "./handler.js";

export const tool = {
  name: "search_tags",
  description: "Search for tags by partial name, description, unit, or subsystem.",
  schema: searchTagsSchema,
  execute,
  metadata: {
    category: "tags" as const,
    freshness: "live" as const,
    expensive: false
  }
};
