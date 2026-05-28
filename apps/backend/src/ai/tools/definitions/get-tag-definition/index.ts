import { getTagDefinitionSchema } from "./schema.js";
import { execute } from "./handler.js";

export const tool = {
  name: "get_tag_definition",
  description: "Get threshold and configuration details for a tag.",
  schema: getTagDefinitionSchema,
  execute,
  metadata: {
    category: "tags" as const,
    freshness: "live" as const,
    expensive: false,
  },
};