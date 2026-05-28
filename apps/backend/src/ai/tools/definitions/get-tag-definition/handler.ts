import type { ToolContext } from "../../execute-tool.js";
import type { GetTagDefinitionArgs } from "./schema.js";
import { resolveTagMatches } from "../../shared/helpers.js";

export async function execute(args: GetTagDefinitionArgs, context: ToolContext) {
  const machineId = args.machineId || context.machineId;
  const query = args.tag;
  const matches = await resolveTagMatches(query, machineId, 3);
  if (!matches.length) {
    return {
      error: `Tag not found: ${query}. Use search_tags to find available tags.`,
    };
  }
  if (matches.length > 1) {
    return {
      note: "Multiple matches found. Ask with a more specific tag name or slug.",
      matches,
    };
  }
  return matches[0];
}
