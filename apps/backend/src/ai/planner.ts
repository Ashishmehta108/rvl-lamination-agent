import type { FastifyBaseLogger } from "fastify";
import type { QueryClass, AgentPlan, PlanStep } from "./types.js";
import { classifyQueryWithSmallModel } from "./classifier.js";
import { resolveDiagnosticSubQueries } from "./decomposer.js";
import { userNamesExplicitPastWindow, getIstTodayWindow } from "./prompts.js";

export async function buildAgentPlan(
  userMessage: string,
  logger: FastifyBaseLogger,
): Promise<{ plan: AgentPlan; queryClass: QueryClass }> {
  console.log(`\x1b[34m[Agent Planner]\x1b[0m Building operational plan for: "${userMessage}"`);
  const queryClass = await classifyQueryWithSmallModel(userMessage, logger);

  if (queryClass === "informational") {
    const result = {
      queryClass,
      plan: {
        intent: "Informational — answerable from knowledge, no tools needed",
        requiresTools: false,
        steps: [{ id: "s1", description: "Answer from knowledge", status: "pending" as const }]
      }
    };
    console.log(`\x1b[34m[Agent Planner]\x1b[0m Plan generated for informational query (No tools needed).`);
    return result;
  }

  const steps: PlanStep[] = [];
  let id = 0;
  const push = (tool: string, description: string) =>
    steps.push({ id: `s${++id}`, tool, description, status: "pending" });

  if (queryClass === "all_tags") {
    push("get_all_live_tags", "Fetch ALL live tag values grouped by subsystem");
  } else if (queryClass === "diagnostic") {
    const subQueries = await resolveDiagnosticSubQueries(userMessage, logger);
    for (const sq of subQueries) {
      push(sq.tool, sq.question);
    }
    steps.push({
      id: `s${++id}`,
      description: "Synthesize root cause and operator actions from evidence",
      status: "pending"
    });
  } else if (queryClass === "historical") {
    push("get_alert_history", "Load alerts in the requested time window");
    push("get_tag_history", "Load primary tag values in the window (speed, meter, RPM)");
  } else if (queryClass === "production") {
    push("get_production_summary", "Fetch production metrics for the relevant window");
    if (queryClass === "production" && userNamesExplicitPastWindow(userMessage)) {
      push("get_tag_history", "Load speed/meter trends for the stated past window");
    }
  } else {
    // current — fixed live-data path; model chooses extra tags if needed
    push("get_machine_status", "Establish live machine health and subsystem state");
    push("get_active_alerts", "List open alerts only (status=open)");
  }

  const plan = {
    intent: `[${queryClass.toUpperCase()}] ${userMessage.slice(0, 100)}`,
    requiresTools: true,
    steps
  };

  console.log(`\x1b[34m[Agent Planner]\x1b[0m Generated Plan [${queryClass.toUpperCase()}]:`);
  for (const step of plan.steps) {
    console.log(`  - \x1b[33m${step.id}\x1b[0m: [${step.tool || 'NO TOOL'}] ${step.description}`);
  }

  return {
    queryClass,
    plan
  };
}

/** Scope alert history to today IST when the user did not ask for a past window. */
export function normalizeToolArgsForQuery(
  name: string,
  args: Record<string, unknown>,
  ctx: { queryClass: QueryClass; userMessage: string }
): Record<string, unknown> {
  if (name !== "get_alert_history") return args;
  if (ctx.queryClass === "historical" || userNamesExplicitPastWindow(ctx.userMessage)) {
    return args;
  }

  const from = args.from;
  const fromStr = typeof from === "string" ? from.trim().toLowerCase() : "";
  const vagueDefault =
    !fromStr || fromStr === "24h" || fromStr === "8h" || fromStr === "7d" || fromStr === "1d";

  if (!vagueDefault) return args;

  const { fromIso, toIso } = getIstTodayWindow();
  return {
    ...args,
    from: fromIso,
    to: typeof args.to === "string" && args.to.trim() ? args.to : toIso
  };
}
