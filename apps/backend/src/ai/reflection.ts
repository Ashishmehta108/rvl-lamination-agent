import type { AgentToolStep, ReflectionSeverity } from "./types.js";

export function reflect(toolSteps: AgentToolStep[]): {
  note: string;
  needsFollowUp: boolean;
  severity: ReflectionSeverity;
} {
  console.log(`\x1b[34m[Agent Reflection]\x1b[0m Analyzing operational health of ${toolSteps.length} step(s)...`);
  const failed = toolSteps.filter(s => s.status === "error" || s.status === "timeout");
  const succeeded = toolSteps.filter(s => s.status === "success");
  const total = toolSteps.filter(s => s.status !== "skipped").length;

  if (!failed.length) {
    const res = { note: "", needsFollowUp: false, severity: "ok" as const };
    console.log(`\x1b[34m[Agent Reflection]\x1b[0m \x1b[32m[OK]\x1b[0m All operational tool calls executed successfully.`);
    return res;
  }

  const allFailed = succeeded.length === 0 && failed.length > 0;
  const criticalTools = ["get_machine_status", "get_active_alerts", "get_all_live_tags", "get_alert_history"];
  const criticalFailed = failed.some(s => criticalTools.includes(s.tool));
  const failRate = failed.length / Math.max(1, total);

  if (allFailed) {
    const res = {
      note: `⚠ All ${failed.length} tool(s) failed — no live data available. Answer is based on prior context only.`,
      needsFollowUp: false,
      severity: "failed" as const
    };
    console.warn(`\x1b[31m[Agent Reflection]\x1b[0m \x1b[31m[FAILED]\x1b[0m All tool calls failed! Severity: failed. Note: ${res.note}`);
    return res;
  }

  if (criticalFailed || failRate >= 0.5) {
    const names = failed.map(s => s.tool).join(", ");
    const res = {
      note: `⚠ Critical data unavailable (${names}). Answer may be incomplete — verify with a follow-up query.`,
      needsFollowUp: true,
      severity: "degraded" as const
    };
    console.warn(`\x1b[33m[Agent Reflection]\x1b[0m \x1b[33m[DEGRADED]\x1b[0m Critical tool(s) failed: [${names}]. Severity: degraded. Note: ${res.note}`);
    return res;
  }

  const res = {
    note: `${failed.length} of ${total} tool(s) failed and were skipped. Partial data used.`,
    needsFollowUp: false,
    severity: "partial" as const
  };
  console.log(`\x1b[33m[Agent Reflection]\x1b[0m \x1b[33m[PARTIAL]\x1b[0m Some non-critical tool calls failed. Severity: partial. Note: ${res.note}`);
  return res;
}
