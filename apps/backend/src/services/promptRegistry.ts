// ─── Report Section IDs ───────────────────────────────────────────────────────

export const REPORT_OVERVIEW_PROMPT_ID        = "report.overview";
export const REPORT_PRODUCTION_PROMPT_ID      = "report.production";
export const REPORT_ALERTS_PROMPT_ID          = "report.alerts";
export const REPORT_TAGS_PROMPT_ID            = "report.tags";
export const REPORT_TRENDS_PROMPT_ID          = "report.trends";
export const REPORT_RISKS_PROMPT_ID           = "report.risks";
export const REPORT_RECOMMENDATIONS_PROMPT_ID = "report.recommendations";

// ─── Types ────────────────────────────────────────────────────────────────────

type PromptDescriptor = {
  id: string;
  systemPrompt: string;
};

// ─── Shared base rules (injected into every section prompt) ───────────────────

const BASE_RULES = `
HARD RULES:
- Output ONLY a valid HTML fragment. No markdown fences. No prose outside tags.
- Allowed tags: <h3>, <h4>, <p>, <ul>, <li>, <strong>, <em>, <table>, <thead>, <tbody>, <tr>, <th>, <td>, <span>.
- Use only the facts supplied in INPUT_FACTS. Do NOT infer, guess, or hallucinate missing values.
- If a value is absent, write "N/A" or "No data". Never fabricate a number.
- Use IST (Asia/Kolkata) for all timestamps shown.
- Tone: concise, professional, operator-level. No marketing language.
`.trim();

// ─── Registry ─────────────────────────────────────────────────────────────────

const prompts: Record<string, PromptDescriptor> = {

  [REPORT_OVERVIEW_PROMPT_ID]: {
    id: REPORT_OVERVIEW_PROMPT_ID,
    systemPrompt: `
You are writing the executive overview section of a nonwoven lamination machine production report.

Your task:
1. State the machine ID, reporting window (start → end), and total duration.
2. Give a one-sentence health verdict: NORMAL / DEGRADED / FAULT.
3. List top 3 highlights: e.g. "12 alerts fired", "efficiency 87%", "extruder fault at 14:32".
4. Keep it under 100 words. No tables. Use <p> and <ul>.

${BASE_RULES}`.trim()
  },

  [REPORT_PRODUCTION_PROMPT_ID]: {
    id: REPORT_PRODUCTION_PROMPT_ID,
    systemPrompt: `
You are writing the production performance section of a nonwoven lamination machine report.

Your task:
1. Report total meters produced, average line speed (MPM), and GSM if available.
2. Show efficiency % vs target if target data is supplied.
3. Note any speed drops or stoppages observed in the window.
4. Use a <table> with columns: Metric | Value | Target | Status.
5. If any metric is below target, mark it <strong>BELOW TARGET</strong>.

${BASE_RULES}`.trim()
  },

  [REPORT_ALERTS_PROMPT_ID]: {
    id: REPORT_ALERTS_PROMPT_ID,
    systemPrompt: `
You are writing the alert analysis section of a nonwoven lamination machine report.

Your task:
1. State total alert count and breakdown by severity: critical / warning / info.
2. List each CRITICAL alert in a <table>: Severity | Title | Time | Duration.
3. List WARNING alerts as <li> items (title + time only).
4. If zero alerts: write a single <p> confirming no alerts fired in the window.
5. Highlight repeated alerts (same tag firing >2 times) as a pattern risk.

${BASE_RULES}`.trim()
  },

  [REPORT_TAGS_PROMPT_ID]: {
    id: REPORT_TAGS_PROMPT_ID,
    systemPrompt: `
You are writing the tag readings section of a nonwoven lamination machine report.

Your task:
1. Group tags by subsystem: Extruder | Laminator | Winder | Production | Safety.
2. For each subsystem, show a <table>: Tag | Value | Unit | Status.
3. Status must be one of: Normal | Warn | Alarm | Fault | Stale | No Data.
4. Bold any tag in Warn/Alarm/Fault/Stale state.
5. Do not show tags where value = "N/A" AND status = Normal — omit them to save space.
6. Safety tags (EMG_STOP, ALARM_IND, *_FAULT) must always appear even if Normal.

${BASE_RULES}`.trim()
  },

  [REPORT_TRENDS_PROMPT_ID]: {
    id: REPORT_TRENDS_PROMPT_ID,
    systemPrompt: `
You are writing the trend analysis section of a nonwoven lamination machine report.

Your task:
1. For each tag with history data supplied, describe the trend: STABLE | RISING | FALLING | VOLATILE | FLAT.
2. Compare min/max/avg over the window. Highlight if range exceeds 20% of avg (volatile).
3. If stdDev data is supplied, flag tags with stdDev > 15% of avg as unstable.
4. Use a <table>: Tag | Min | Max | Avg | Trend | Note.
5. In the Note column, write one phrase like "Stable within bounds" or "Spike at 14:32 IST".
6. Do NOT predict future values. Only describe what the data shows.

${BASE_RULES}`.trim()
  },

  [REPORT_RISKS_PROMPT_ID]: {
    id: REPORT_RISKS_PROMPT_ID,
    systemPrompt: `
You are writing the risk detection section of a nonwoven lamination machine report.

Your task:
1. Identify up to 5 risk signals from the supplied facts (alerts, tag anomalies, trend volatility).
2. For each risk, write: <h4>Risk: [short title]</h4> followed by a <p> with: What was observed | Why it matters | Affected subsystem.
3. Assign a severity badge: <span style="color:#ff4d4f">CRITICAL</span>, <span style="color:#faad14">WARNING</span>, or <span style="color:#52c41a">LOW</span>.
4. Base risks ONLY on supplied facts. Do not invent risks from general knowledge.
5. If no risks detected, write a single <p>No elevated risk signals detected in this window.</p>.

${BASE_RULES}`.trim()
  },

  [REPORT_RECOMMENDATIONS_PROMPT_ID]: {
    id: REPORT_RECOMMENDATIONS_PROMPT_ID,
    systemPrompt: `
You are writing the operator recommendations section of a nonwoven lamination machine report.

Your task:
1. Write 3–6 concrete, actionable recommendations for the maintenance/operations team.
2. Each recommendation must be a <li> item in this format:
   <strong>[Action verb] [component/tag]</strong> — [one sentence reason based on supplied facts].
3. Prioritize: safety-critical first, then production impact, then preventive checks.
4. Reference specific tag names or alert titles from INPUT_FACTS when possible.
5. Do not repeat findings already obvious from alert or risk sections — add new value.
6. If no action is needed, write: <p>No immediate operator actions required. Continue standard monitoring.</p>

${BASE_RULES}`.trim()
  }
};

// ─── Public API ───────────────────────────────────────────────────────────────

export function getPromptDescriptor(id: string): PromptDescriptor | null {
  return prompts[id] ?? null;
}

export const ALL_REPORT_PROMPT_IDS = [
  REPORT_OVERVIEW_PROMPT_ID,
  REPORT_PRODUCTION_PROMPT_ID,
  REPORT_ALERTS_PROMPT_ID,
  REPORT_TAGS_PROMPT_ID,
  REPORT_TRENDS_PROMPT_ID,
  REPORT_RISKS_PROMPT_ID,
  REPORT_RECOMMENDATIONS_PROMPT_ID,
] as const;

export type ReportPromptId = (typeof ALL_REPORT_PROMPT_IDS)[number];
