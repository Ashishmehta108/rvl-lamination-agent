import assert from "node:assert/strict";
import { ALL_TOOL_DECLARATIONS } from "../ai/index.js";
import { SYSTEM_PROMPT } from "../ai/prompts.js";

function main(): void {
  const toolNames = new Set(ALL_TOOL_DECLARATIONS.map((tool) => tool.name));
  for (const expected of [
    "get_live_tag_values",
    "get_all_live_tags",
    "get_tag_history",
    "get_active_alerts",
    "get_alert_history",
    "get_tag_definition",
    "get_production_summary",
    "search_tags",
    "get_machine_status",
    "acknowledge_alert",
    "get_chat_sessions"
  ]) {
    assert.ok(toolNames.has(expected), `missing Gemini tool: ${expected}`);
  }
  assert.ok(SYSTEM_PROMPT.includes("Nonwoven Lamination Machine"));
  console.log("verifyChatPlan: Gemini chat agent checks passed");
}

main();
