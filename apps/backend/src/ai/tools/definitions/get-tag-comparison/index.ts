import { getTagComparisonSchema } from "./schema.js";
import { execute } from "./handler.js";

export const tool = {
  name: "get_tag_comparison",
  description: "Compare multiple tags side-by-side over a time window.",
  schema: getTagComparisonSchema,
  execute,
  metadata: {
    category: "tags" as const,
    freshness: "historical" as const,
    expensive: true
  }
};
