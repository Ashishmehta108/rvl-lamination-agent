import { getChatSessionsSchema } from "./schema.js";
import { execute } from "./handler.js";

export const tool = {
  name: "get_chat_sessions",
  description: "List recent chat sessions for a machine.",
  schema: getChatSessionsSchema,
  execute,
  metadata: {
    category: "chat" as const,
    freshness: "live" as const,
    expensive: false
  }
};
