import { getMachineStatusSchema } from "./schema.js";
import { execute } from "./handler.js";

export const tool = {
  name: "get_machine_status",
  description: "Get a quick health overview of the entire machine.",
  schema: getMachineStatusSchema,
  execute,
  metadata: {
    category: "machine" as const,
    freshness: "live" as const,
    expensive: false
  }
};
