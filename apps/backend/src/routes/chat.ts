// import type { FastifyInstance } from "fastify";
// import { ChatRequestSchema } from "@rvl/shared";
// import { requireApiAuth, validateMachineAccess } from "../auth.js";
// import { ragQuery } from "../rag/store.js";
// import { chatOnce, chatOnceWithModel } from "../llm/ollama.js";
// import { config } from "../config.js";
// import { fetchLiveContext } from "./chatContext.js";
// import {
//   defaultToolPlan,
//   parsePlannerJson,
//   PLANNER_SYSTEM,
//   wantsToolPipeline
// } from "../services/chatPlanner.js";
// import { runToolPlan, type ChatToolCall, type FindTagCandidate } from "../services/chatTools.js";

// /* ─────────────────────────────────────────────────────────────────
//    SECTION 1 — TYPES
//    Pre-computed machine context passed to handle().
//    The LLM never sees raw tag IDs, slugs, or internal metadata.
//    All numbers, comparisons, and anomalies are resolved upstream.
//    ───────────────────────────────────────────────────────────────── */

// type HealthStatus = "healthy" | "degraded" | "critical" | "unknown";
// type AlertSeverity = "critical" | "warning" | "info";
// type AlertStatus = "open" | "acknowledged" | "resolved";
// type ReadingFlag = "normal" | "watch" | "fault" | null;
// type QueryIntent = "status" | "tags" | "alerts" | "general";

// interface Reading {
//   label: string;       // Human-friendly: "Speed", "Tension", "Current"
//   value: string;       // Pre-formatted with unit: "64% (79.9 RPM)", "132 N"
//   capturedAt: string;  // Pre-formatted: "2:43 pm"
//   flag: ReadingFlag;
// }

// interface SystemGroup {
//   label: string;       // "Extruder" | "Laminator" | "Winder" | "General"
//   readings: Reading[];
// }

// interface AlertItem {
//   severity: AlertSeverity;
//   title: string;
//   status: AlertStatus;
//   detectedAt: string;  // Pre-formatted
//   context: string | null; // Max 120 chars, sanitized upstream
// }

// interface WatchItem {
//   label: string;
//   observation: string; // Pre-written: "132 vs setpoint 151 — 13% below"
// }

// interface MachineContext {
//   meta: {
//     machineId: string;
//     machineName: string;
//     capturedAt: string;
//     overallHealth: HealthStatus;
//   };
//   summary: {
//     oneLiner: string | null; // Pre-written upstream, LLM just echoes or expands
//   };
//   systemGroups: SystemGroup[];
//   alerts: AlertItem[];
//   watchItems: WatchItem[];
//   missing: string[];
// }

// /* ─────────────────────────────────────────────────────────────────
//    SECTION 2 — CONSTANTS
//    ───────────────────────────────────────────────────────────────── */

// /** Max items surfaced per section — keeps LLM prompt compact. */
// const MAX_GROUPS = 6;
// const MAX_READINGS_PER_GROUP = 8;
// const MAX_ALERTS = 8;
// const MAX_WATCH_ITEMS = 5;
// const MAX_MISSING_ITEMS = 4;
// const MAX_FREE_TEXT_LEN = 120; // chars — for any user/upstream supplied string

// /** Severity order for deterministic sort: lower index = higher priority. */
// const SEVERITY_RANK: Record<AlertSeverity, number> = { critical: 0, warning: 1, info: 2 };

// /** Emoji per severity — rendered in Phase 1, never by the LLM. */
// const SEVERITY_EMOJI: Record<AlertSeverity, string> = {
//   critical: "🔴",
//   warning: "🟡",
//   info: "ℹ️",
// };

// /** Health intro lines — deterministic, never LLM-generated. */
// const HEALTH_INTRO: Record<HealthStatus, string> = {
//   healthy: "Everything looks good from where I'm standing.",
//   degraded: "Machine's running, but there are a few things worth your attention.",
//   critical: "Heads up — there's at least one critical issue that needs attention now.",
//   unknown: "I've got partial data only — here's what I can see.",
// };

// /* ─────────────────────────────────────────────────────────────────
//    SECTION 3 — INPUT VALIDATION & SANITIZATION
//    Validate and sanitize before anything else runs.
//    Malformed input degrades gracefully — never throws to the route.
//    ───────────────────────────────────────────────────────────────── */

// /** Strip prompt-injection vectors from any free-text field. */
// function sanitize(s: unknown, maxLen = MAX_FREE_TEXT_LEN): string {
//   if (typeof s !== "string") return "";
//   return s
//     .replace(/```[\s\S]*?```/g, "") // strip code fences
//     .replace(/\[.*?\]\(.*?\)/g, "") // strip markdown links
//     .replace(/<[^>]+>/g, "")        // strip HTML tags
//     .replace(/system:/gi, "")       // strip prompt injection attempts
//     .replace(/\bignore\b.{0,40}\binstructions?\b/gi, "")
//     .trim()
//     .slice(0, maxLen);
// }

// function safeString(s: unknown, fallback = "", maxLen = MAX_FREE_TEXT_LEN): string {
//   return typeof s === "string" && s.trim().length > 0
//     ? sanitize(s, maxLen)
//     : fallback;
// }

// function safeArray<T>(v: unknown): T[] {
//   return Array.isArray(v) ? v : [];
// }

// /** Validate and normalize a MachineContext — fills defaults for any missing fields. */
// function normalizeMachineContext(raw: unknown): MachineContext {
//   const r = (raw != null && typeof raw === "object" ? raw : {}) as Record<string, unknown>;

//   const meta = (r["meta"] != null && typeof r["meta"] === "object"
//     ? r["meta"]
//     : {}) as Record<string, unknown>;

//   const summary = (r["summary"] != null && typeof r["summary"] === "object"
//     ? r["summary"]
//     : {}) as Record<string, unknown>;

//   const validHealth = new Set<HealthStatus>(["healthy", "degraded", "critical", "unknown"]);
//   const rawHealth = meta["overallHealth"];
//   const overallHealth: HealthStatus = validHealth.has(rawHealth as HealthStatus)
//     ? (rawHealth as HealthStatus)
//     : "unknown";

//   // Normalize system groups — cap counts, sanitize labels
//   const rawGroups = safeArray<unknown>(r["systemGroups"]).slice(0, MAX_GROUPS);
//   const systemGroups: SystemGroup[] = rawGroups.flatMap(g => {
//     if (g == null || typeof g !== "object") return [];
//     const gr = g as Record<string, unknown>;
//     const label = safeString(gr["label"], "Unknown System", 40);
//     const rawReadings = safeArray<unknown>(gr["readings"]).slice(0, MAX_READINGS_PER_GROUP);
//     const readings: Reading[] = rawReadings.flatMap(rd => {
//       if (rd == null || typeof rd !== "object") return [];
//       const r2 = rd as Record<string, unknown>;
//       const validFlags = new Set<ReadingFlag>(["normal", "watch", "fault", null]);
//       const flag = validFlags.has(r2["flag"] as ReadingFlag) ? (r2["flag"] as ReadingFlag) : null;
//       return [{
//         label: safeString(r2["label"], "Unknown", 60),
//         value: safeString(r2["value"], "N/A", 80),
//         capturedAt: safeString(r2["capturedAt"], "", 20),
//         flag,
//       }];
//     });
//     if (readings.length === 0) return [];
//     return [{ label, readings }];
//   });

//   // Normalize alerts — sort by severity rank, then by detectedAt desc
//   const rawAlerts = safeArray<unknown>(r["alerts"]).slice(0, MAX_ALERTS * 2); // allow extra before sort+slice
//   const alerts: AlertItem[] = rawAlerts
//     .flatMap(a => {
//       if (a == null || typeof a !== "object") return [];
//       const al = a as Record<string, unknown>;
//       const validSev = new Set<AlertSeverity>(["critical", "warning", "info"]);
//       const validStat = new Set<AlertStatus>(["open", "acknowledged", "resolved"]);
//       const severity: AlertSeverity = validSev.has(al["severity"] as AlertSeverity)
//         ? (al["severity"] as AlertSeverity)
//         : "info";
//       const status: AlertStatus = validStat.has(al["status"] as AlertStatus)
//         ? (al["status"] as AlertStatus)
//         : "open";
//       return [{
//         severity,
//         status,
//         title: safeString(al["title"], "Unnamed Alert", 80),
//         detectedAt: safeString(al["detectedAt"], "", 30),
//         context: safeString(al["context"] ?? null, "", 120) || null,
//       }];
//     })
//     .sort((a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity])
//     .slice(0, MAX_ALERTS);

//   // Normalize watch items
//   const watchItems: WatchItem[] = safeArray<unknown>(r["watchItems"])
//     .slice(0, MAX_WATCH_ITEMS)
//     .flatMap(w => {
//       if (w == null || typeof w !== "object") return [];
//       const wi = w as Record<string, unknown>;
//       return [{
//         label: safeString(wi["label"], "Unknown", 60),
//         observation: safeString(wi["observation"], "", 140),
//       }];
//     });

//   // Normalize missing fields
//   const missing: string[] = safeArray<unknown>(r["missing"])
//     .slice(0, MAX_MISSING_ITEMS)
//     .map(m => safeString(m, "", 60))
//     .filter(Boolean);

//   return {
//     meta: {
//       machineId: safeString(meta["machineId"], "unknown", 50),
//       machineName: safeString(meta["machineName"], "Machine", 80),
//       capturedAt: safeString(meta["capturedAt"], "", 30),
//       overallHealth,
//     },
//     summary: {
//       oneLiner: safeString(summary["oneLiner"] ?? null, "", 200) || null,
//     },
//     systemGroups,
//     alerts,
//     watchItems,
//     missing,
//   };
// }

// /* ─────────────────────────────────────────────────────────────────
//    SECTION 4 — PHASE 1: DETERMINISTIC PRE-RENDER
//    All structured output is built here — O(n), no LLM, no inference.
//    The LLM only writes the 2–3 sentence narrative block.
//    ───────────────────────────────────────────────────────────────── */

// interface PreRendered {
//   /** Stable one-liner for the top of the response. */
//   introLine: string;
//   /** Grouped readings block — ready to embed in final markdown. */
//   readingsBlock: string | null;
//   /** Alerts block — sorted, formatted, ready to embed. */
//   alertsBlock: string | null;
//   /** Watch items block — anomalies pre-flagged upstream. */
//   watchBlock: string | null;
//   /** Missing data note, if any. */
//   missingNote: string | null;
//   /** Compact brief for the LLM — only essential facts, no raw slugs. */
//   llmBrief: string;
//   /** True if there's anything real to show. */
//   hasData: boolean;
// }

// function preRender(ctx: MachineContext, intent: QueryIntent): PreRendered {
//   const { meta, summary, systemGroups, alerts, watchItems, missing } = ctx;

//   const hasGroups = systemGroups.length > 0;
//   const hasAlerts = alerts.length > 0;
//   const hasWatch = watchItems.length > 0;
//   const hasMissing = missing.length > 0;
//   const hasData = hasGroups || hasAlerts || hasWatch;

//   // ── Intro line (deterministic — never LLM) ──────────────────────
//   const introLine = summary.oneLiner
//     ? sanitize(summary.oneLiner, 200)
//     : HEALTH_INTRO[meta.overallHealth];

//   // ── Readings block ──────────────────────────────────────────────
//   let readingsBlock: string | null = null;
//   if (hasGroups && (intent === "tags" || intent === "status")) {
//     const sections = systemGroups.map(group => {
//       const lines = group.readings.map(r => {
//         const flagSuffix = r.flag === "fault"
//           ? " ⚠️"
//           : r.flag === "watch"
//             ? " 👀"
//             : "";
//         const time = r.capturedAt ? ` (${r.capturedAt})` : "";
//         return `• **${r.label}:** ${r.value}${time}${flagSuffix}`;
//       });
//       return `**${group.label}**\n${lines.join("\n")}`;
//     });
//     readingsBlock = sections.join("\n\n");
//   }

//   // ── Alerts block ────────────────────────────────────────────────
//   let alertsBlock: string | null = null;
//   if (hasAlerts && (intent === "alerts" || intent === "status")) {
//     const lines = alerts.map(a => {
//       const emoji = SEVERITY_EMOJI[a.severity];
//       const statusLabel = a.status === "open" ? "open" : a.status;
//       const time = a.detectedAt ? ` — ${statusLabel} since ${a.detectedAt}` : ` — ${statusLabel}`;
//       const ctx2 = a.context ? `\n  ${a.context}` : "";
//       return `${emoji} **${a.title}**${time}${ctx2}`;
//     });
//     alertsBlock = lines.join("\n\n");
//   }

//   // ── Watch items block ───────────────────────────────────────────
//   let watchBlock: string | null = null;
//   if (hasWatch) {
//     const lines = watchItems.map(w => `• **${w.label}:** ${w.observation}`);
//     watchBlock = lines.join("\n");
//   }

//   // ── Missing note ────────────────────────────────────────────────
//   let missingNote: string | null = null;
//   if (hasMissing) {
//     missingNote = `No data available for: ${missing.join(", ")}.`;
//   }

//   // ── LLM brief ──────────────────────────────────────────────────
//   // This is a compact, token-efficient summary of what's in the context.
//   // The LLM reads this and writes the narrative glue — nothing else.
//   // It never sees raw tag IDs, slugs, or the full readings list.
//   const briefParts: string[] = [];

//   briefParts.push(`Machine: ${meta.machineName}. Health: ${meta.overallHealth}.`);

//   if (summary.oneLiner) {
//     briefParts.push(`Status: ${summary.oneLiner}`);
//   }

//   if (hasAlerts) {
//     const critCount = alerts.filter(a => a.severity === "critical").length;
//     const warnCount = alerts.filter(a => a.severity === "warning").length;
//     const parts: string[] = [];
//     if (critCount > 0) parts.push(`${critCount} critical`);
//     if (warnCount > 0) parts.push(`${warnCount} warning`);
//     briefParts.push(`Alerts: ${parts.length > 0 ? parts.join(", ") : alerts.length + " total"}.`);
//     // Surface top 2 alert titles for narrative context
//     alerts.slice(0, 2).forEach(a => {
//       const ctx2 = a.context ? ` — ${a.context}` : "";
//       briefParts.push(`  [${a.severity.toUpperCase()}] ${a.title}${ctx2}`);
//     });
//   } else {
//     briefParts.push("Alerts: none.");
//   }

//   if (hasWatch) {
//     briefParts.push("Watch items:");
//     watchItems.slice(0, 3).forEach(w => {
//       briefParts.push(`  ${w.label}: ${w.observation}`);
//     });
//   }

//   if (hasMissing) {
//     briefParts.push(`Missing data: ${missing.join(", ")}.`);
//   }

//   const llmBrief = briefParts.join("\n");

//   return {
//     introLine,
//     readingsBlock,
//     alertsBlock,
//     watchBlock,
//     missingNote,
//     llmBrief,
//     hasData,
//   };
// }

// /* ─────────────────────────────────────────────────────────────────
//    SECTION 5 — PHASE 2: LLM PROMPT BUILDER
//    The LLM receives only the compact brief and writes
//    one short narrative paragraph. It never calculates,
//    infers, or re-formats the readings — those are already done.
//    ───────────────────────────────────────────────────────────────── */

// const RAVI_PERSONA = `You are Ravi, the RVL Lamination Assistant. You're the colleague everyone wants on shift — calm, experienced, and straight to the point. You speak like a person, not a report.`;

// const NARRATIVE_RULES = `RULES FOR YOUR RESPONSE:
// - Write exactly 2–4 sentences. No more.
// - Use the BRIEF below — do not invent facts, numbers, or observations not present in it.
// - Speak naturally. Contractions are fine. Short sentences are great.
// - If health is "healthy" and no alerts: be reassuring but specific.
// - If there are watch items or alerts: acknowledge the most important one clearly.
// - If data is missing: mention it briefly and move on.
// - Do NOT list readings — those are already shown separately.
// - Do NOT end with filler like "Let me know if you need anything."
// - Do NOT add numbers, percentages, or calculations not in the BRIEF.
// - Do NOT repeat the machine name unless natural.`;

// function buildLlmPrompt(brief: string, intent: QueryIntent, userQuery: string): string {
//   const intentHint =
//     intent === "alerts"
//       ? "The operator is asking about alerts. Focus your narrative on the alert situation."
//       : intent === "tags"
//         ? "The operator wants to see current readings. Your narrative should give a quick health read on what the data shows overall."
//         : intent === "status"
//           ? "The operator wants a status overview. Give a confident, grounded one-paragraph brief."
//           : `The operator asked: "${sanitize(userQuery, 120)}". Answer using only what's in the BRIEF.`;

//   return `${RAVI_PERSONA}

// ${NARRATIVE_RULES}

// CONTEXT BRIEF:
// ${brief}

// INTENT: ${intentHint}

// Write your 2–4 sentence response now:`;
// }

// /* ─────────────────────────────────────────────────────────────────
//    SECTION 6 — PHASE 3: FINAL ASSEMBLY
//    Combines deterministic pre-rendered blocks with the LLM narrative.
//    Ordering is fixed and never depends on LLM output.
//    ───────────────────────────────────────────────────────────────── */

// function assembleFinalAnswer(
//   narrative: string,
//   pre: PreRendered,
//   intent: QueryIntent
// ): string {
//   // Strip any leaked internal content from LLM narrative
//   const cleanNarrative = stripInternalHeaders(narrative).trim();

//   const sections: string[] = [];

//   // 1. Narrative (LLM-written, always first)
//   if (cleanNarrative) {
//     sections.push(cleanNarrative);
//   }

//   // 2. Alerts block (shown for alert intent or when critical alerts exist)
//   if (pre.alertsBlock) {
//     sections.push(pre.alertsBlock);
//   }

//   // 3. Watch items (shown when present and intent isn't pure alerts)
//   if (pre.watchBlock && intent !== "alerts") {
//     sections.push(`**Worth watching:**\n${pre.watchBlock}`);
//   }

//   // 4. Readings (shown for tags/status intent)
//   if (pre.readingsBlock) {
//     sections.push(pre.readingsBlock);
//   }

//   // 5. Missing note (always last, never highlighted)
//   if (pre.missingNote) {
//     sections.push(`_${pre.missingNote}_`);
//   }

//   // Empty data fallback — fully deterministic, no LLM
//   if (!pre.hasData && !cleanNarrative) {
//     return "Hmm, I don't have live data for that right now. Check back in a moment or try refreshing the machine connection.";
//   }

//   return sections.join("\n\n");
// }

// /* ─────────────────────────────────────────────────────────────────
//    SECTION 7 — INTENT DETECTION
//    Resolved here from the user query — never passed to the LLM.
//    ───────────────────────────────────────────────────────────────── */

// function resolveIntent(query: string, tagIds?: string[]): QueryIntent {
//   const q = query.toLowerCase();
//   if (/\b(alert|alerts|warning|warnings|critical|fired|fault|faults)\b/.test(q)) return "alerts";
//   if (/\b(list|all|tags|readings|values|show|every|current|status|dashboard|overview)\b/.test(q)) {
//     return tagIds && tagIds.length > 0 ? "tags" : "status";
//   }
//   if (tagIds && tagIds.length > 0) return "tags";
//   return "general";
// }

// function isGreetingLike(text: string): boolean {
//   const t = text.trim().toLowerCase();
//   if (t.length > 60) return false;
//   return /^(hi|hello|hey|thanks|thank you)\b/.test(t);
// }

// /* ─────────────────────────────────────────────────────────────────
//    SECTION 8 — LIVE DATA → MachineContext TRANSFORMER
//    Converts raw tag/alert context from existing fetchers into the
//    normalized MachineContext shape. This is the bridge between the
//    legacy fetching layer and the new rendering layer.
//    ───────────────────────────────────────────────────────────────── */

// const SYSTEM_GROUP_PREFIXES: [string, string][] = [
//   ["EXTRUDER", "Extruder"],
//   ["LAMINATOR", "Laminator"],
//   ["WINDER", "Winder"],
//   ["UW", "Unwinder"],
//   ["SPLICE", "Splice"],
//   ["GSM", "General"],
//   ["GRAM", "General"],
//   ["MASTER", "General"],
//   ["ALARM", "General"],
//   ["EMG", "General"],
//   ["RUNNING", "General"],
//   ["TOTAL", "General"],
// ];

// function slugToLabel(slug: string): string {
//   return slug
//     .split("_")
//     .map(w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
//     .join(" ")
//     .replace(/\bOn Off\b/i, "On/Off")
//     .replace(/\bAmp\b/i, "Current (A)")
//     .replace(/\bPct\b/i, "%")
//     .replace(/\bMpm\b/i, "m/min")
//     .replace(/\bRpm\b/i, "RPM")
//     .replace(/\bPv\b/i, "Present")
//     .replace(/\bVol\b/i, "Voltage")
//     .replace(/\bGsm\b/i, "GSM")
//     .replace(/\bInd\b/i, "Indicator")
//     .replace(/\bEmg\b/i, "Emergency");
// }

// function groupSlug(slug: string): string {
//   const upper = slug.toUpperCase();
//   for (const [prefix, group] of SYSTEM_GROUP_PREFIXES) {
//     if (upper.startsWith(prefix)) return group;
//   }
//   return "General";
// }

// /**
//  * Parse "* SLUG: value [time]" lines from raw tag context text.
//  * Returns structured readings grouped by system.
//  */
// function parseTagContextToGroups(liveContexts: { source: string; text: string }[]): SystemGroup[] {
//   const tagBlock =
//     liveContexts.find(c => c.source === "tags_db") ??
//     liveContexts.find(c => c.source === "tags_selected");

//   if (!tagBlock) return [];

//   const grouped = new Map<string, Reading[]>();

//   for (const line of tagBlock.text.split("\n")) {
//     const m = line.trim().match(/^\*\s+([A-Z][A-Z0-9_]+):\s*(.+?)\s*(?:\[(.+?)\])?$/);
//     if (!m) continue;

//     const [, slug, rawValue, rawTime] = m;
//     const groupName = groupSlug(slug);
//     const label = slugToLabel(slug);

//     // Determine flag from well-known fault/alarm slugs
//     const upperSlug = slug.toUpperCase();
//     const flag: ReadingFlag =
//       (upperSlug.includes("FAULT") || upperSlug.includes("ALARM") || upperSlug.includes("EMG"))
//         ? (rawValue.trim() === "0" ? "normal" : "fault")
//         : null;

//     const reading: Reading = {
//       label,
//       value: rawValue.trim(),
//       capturedAt: rawTime?.trim() ?? "",
//       flag,
//     };

//     if (!grouped.has(groupName)) grouped.set(groupName, []);
//     grouped.get(groupName)!.push(reading);
//   }

//   // Fixed group order
//   const ORDER = ["Extruder", "Laminator", "Winder", "Unwinder", "Splice", "General"];
//   const result: SystemGroup[] = [];
//   for (const label of ORDER) {
//     const readings = grouped.get(label);
//     if (readings && readings.length > 0) {
//       result.push({ label, readings: readings.slice(0, MAX_READINGS_PER_GROUP) });
//     }
//   }
//   // Any groups not in the fixed order appended last
//   for (const [label, readings] of grouped) {
//     if (!ORDER.includes(label)) {
//       result.push({ label, readings: readings.slice(0, MAX_READINGS_PER_GROUP) });
//     }
//   }

//   return result.slice(0, MAX_GROUPS);
// }

// /**
//  * Parse "ALERT #N: [SEVERITY] status: ... | title: ... | detected at: ..." lines.
//  */
// function parseAlertContextToAlerts(liveContexts: { source: string; text: string }[]): AlertItem[] {
//   const alertBlock = liveContexts.find(c => c.source === "alerts_db");
//   if (!alertBlock) return [];

//   const alerts: AlertItem[] = [];

//   for (const line of alertBlock.text.split("\n")) {
//     const m = line.match(
//       /ALERT\s*#\d+:\s*\[(\w+)\]\s*status:\s*(\w+)\s*\|\s*title:\s*"([^"]+)"\s*\|\s*detected at:\s*([^|]+)(?:\|\s*description:\s*(.+))?/i
//     );
//     if (!m) continue;

//     const [, rawSev, rawStatus, title, detectedAt, description] = m;

//     const validSev = new Set<AlertSeverity>(["critical", "warning", "info"]);
//     const validStat = new Set<AlertStatus>(["open", "acknowledged", "resolved"]);
//     const severity: AlertSeverity = validSev.has(rawSev.toLowerCase() as AlertSeverity)
//       ? (rawSev.toLowerCase() as AlertSeverity)
//       : "info";
//     const status: AlertStatus = validStat.has(rawStatus.toLowerCase() as AlertStatus)
//       ? (rawStatus.toLowerCase() as AlertStatus)
//       : "open";

//     alerts.push({
//       severity,
//       status,
//       title: sanitize(title, 80),
//       detectedAt: sanitize(detectedAt.trim(), 30),
//       context: description ? sanitize(description.trim(), 120) : null,
//     });
//   }

//   return alerts
//     .sort((a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity])
//     .slice(0, MAX_ALERTS);
// }

// /**
//  * Derive pre-computed watch items from readings.
//  * Only surfaces items that are explicitly flagged "watch" or "fault" upstream.
//  * Does NOT infer or calculate — just collects what's already marked.
//  */
// function deriveWatchItems(groups: SystemGroup[]): WatchItem[] {
//   const items: WatchItem[] = [];
//   for (const group of groups) {
//     for (const r of group.readings) {
//       if (r.flag === "fault" || r.flag === "watch") {
//         items.push({
//           label: `${group.label} — ${r.label}`,
//           observation: `${r.value}${r.capturedAt ? ` at ${r.capturedAt}` : ""}`,
//         });
//       }
//     }
//     if (items.length >= MAX_WATCH_ITEMS) break;
//   }
//   return items.slice(0, MAX_WATCH_ITEMS);
// }

// /**
//  * Derive overall health from alerts and fault flags.
//  * Pure function, no inference — just checks explicit flags.
//  */
// function deriveHealth(alerts: AlertItem[], groups: SystemGroup[]): HealthStatus {
//   if (alerts.some(a => a.severity === "critical" && a.status === "open")) return "critical";
//   if (alerts.some(a => a.severity === "warning" && a.status === "open")) return "degraded";
//   if (groups.length === 0) return "unknown";
//   const hasFault = groups.some(g => g.readings.some(r => r.flag === "fault"));
//   if (hasFault) return "degraded";
//   return "healthy";
// }

// /**
//  * Build MachineContext from raw liveContexts.
//  * This is the full bridge from legacy fetchers → new rendering pipeline.
//  */
// function buildMachineContext(
//   machineId: string,
//   liveContexts: { source: string; text: string }[],
//   capturedAt: string
// ): MachineContext {
//   const systemGroups = parseTagContextToGroups(liveContexts);
//   const alerts = parseAlertContextToAlerts(liveContexts);
//   const watchItems = deriveWatchItems(systemGroups);
//   const overallHealth = deriveHealth(alerts, systemGroups);

//   return {
//     meta: {
//       machineId,
//       machineName: "RVL Laminator",
//       capturedAt,
//       overallHealth,
//     },
//     summary: { oneLiner: null }, // upstream can set this; LLM fills it via narrative
//     systemGroups,
//     alerts,
//     watchItems,
//     missing: [],
//   };
// }

// /* ─────────────────────────────────────────────────────────────────
//    SECTION 9 — HALLUCINATION GUARD
//    Tightened to only match ALL_CAPS_WITH_UNDERSCORE tag slugs.
//    Requires 3+ unknown slugs before firing.
//    Fallback is a humanized snapshot, never a raw dump.
//    ───────────────────────────────────────────────────────────────── */

// function extractLiveTagSlugs(liveContexts: { source: string; text: string }[]): Set<string> {
//   const s = new Set<string>();
//   for (const c of liveContexts) {
//     if (c.source !== "tags_db" && c.source !== "tags_selected") continue;
//     for (const m of c.text.matchAll(/^\s*\*\s+([A-Z][A-Z0-9_]{1,})\s*:/gm)) if (m[1]) s.add(m[1]);
//   }
//   return s;
// }

// function extractMentionedSlugs(answer: string): Set<string> {
//   const s = new Set<string>();
//   // Only ALL_CAPS_WITH_UNDERSCORE — real tag slugs always have underscores
//   for (const m of answer.matchAll(/\b([A-Z][A-Z0-9]{1,}(?:_[A-Z0-9]+)+)\b/g)) {
//     if (m[1]) s.add(m[1]);
//   }
//   return s;
// }

// function buildHumanizedFallback(ctx: MachineContext): string {
//   if (ctx.systemGroups.length === 0) {
//     return "I don't have enough data to show right now. Try again in a moment.";
//   }
//   const lines: string[] = ["Here's what I'm seeing on the machine right now:", ""];
//   for (const group of ctx.systemGroups.slice(0, 4)) {
//     lines.push(`**${group.label}**`);
//     for (const r of group.readings.slice(0, 6)) {
//       const time = r.capturedAt ? ` (${r.capturedAt})` : "";
//       lines.push(`• **${r.label}:** ${r.value}${time}`);
//     }
//     lines.push("");
//   }
//   return lines.join("\n").trim();
// }

// /* ─────────────────────────────────────────────────────────────────
//    SECTION 10 — UTILITY
//    ───────────────────────────────────────────────────────────────── */

// function stripInternalHeaders(text: string): string {
//   return text
//     .replace(/---\s*TOOL_RESULTS\s*---/gi, "")
//     .replace(/\[TOOL_DATA:[^\]]*\]/gi, "")
//     .replace(/\[DOCUMENTS\]/gi, "")
//     .replace(/FIND_TAGS:[^\n]*/gi, "")
//     .replace(/ACTIVE ALERTS \(last \d+ days\):\n?/gi, "")
//     .replace(/MACHINE STATE SNAPSHOT[^\n]*:\n?/gi, "")
//     .replace(/CURRENT TELEMETRY[^\n]*:\n?/gi, "")
//     .replace(/TELEMETRY SNAPSHOT:\n?/gi, "")
//     .trim();
// }

// function needsCitationGuard(answer: string, ragCount: number): string {
//   if (ragCount === 0) return answer;
//   if (/\[#\d+\]/.test(answer)) return answer;
//   return `${answer}\n\n_No document citations detected — verify critical values against primary systems._`;
// }

// function toolBlocksToLiveContexts(toolBlocks: { name: string; text: string }[]): { source: string; text: string }[] {
//   return toolBlocks
//     .filter(b => b.name !== "find_tags")
//     .map(b => ({
//       source:
//         b.name === "get_tags" ? "tags_db"
//           : b.name === "get_alerts" ? "alerts_db"
//             : `tool_${b.name}`,
//       text: b.text,
//     }));
// }

// /* ─────────────────────────────────────────────────────────────────
//    SECTION 11 — LEGACY RAG SYSTEM PROMPT
//    Used when the tool pipeline is NOT active (RAG-only path).
//    Compact, stripped of verbose rule lists.
//    ───────────────────────────────────────────────────────────────── */

// function buildRagSystemPrompt(
//   ragContexts: { text: string; chunkId: string; sourceUri?: string }[],
//   liveContexts: { source: string; text: string }[]
// ): string {
//   const hasAny = ragContexts.length > 0 || liveContexts.length > 0;

//   const persona = `You are Ravi, the RVL Lamination Assistant — a warm, experienced colleague. Speak plainly and directly. Lead with the actual answer. Use exact values from CONTEXT. Never invent data. Never end with hollow closings.`;

//   if (!hasAny) {
//     return `${persona}\n\nCONTEXT:\n(empty — no live data available right now)`;
//   }

//   const parts: string[] = [];
//   if (liveContexts.length > 0) {
//     const clean = liveContexts.filter(
//       c => !c.text.includes("No definitions matched") && !c.text.includes("No tags found")
//     );
//     parts.push(...(clean.length > 0 ? clean : liveContexts).map(c => c.text));
//   }
//   if (ragContexts.length > 0) {
//     parts.push(...ragContexts.map((c, i) => `[#${i + 1}] ${c.text}`));
//   }

//   return `${persona}\n\nCONTEXT:\n${parts.join("\n\n")}`;
// }

// /* ─────────────────────────────────────────────────────────────────
//    SECTION 12 — ROUTE REGISTRATION
//    ───────────────────────────────────────────────────────────────── */

// export async function registerChatRoutes(app: FastifyInstance) {
//   const chatRate = (app as any).rateLimit?.bind(app);
//   const chatRateHandler = chatRate
//     ? chatRate({
//       max: config.chatRateLimitMax,
//       timeWindow: "1 minute",
//       keyGenerator: (request: any) => {
//         const auth = request.headers["authorization"] ?? request.headers["Authorization"] ?? "";
//         const a = Array.isArray(auth) ? auth[0] : auth;
//         return `${request.ip}|${String(a ?? "").slice(0, 64)}`;
//       },
//     })
//     : undefined;

//   app.post(
//     "/chat",
//     chatRateHandler ? { preHandler: [chatRateHandler] } : {},
//     async (req, reply) => {
//       const reqLog = req.log.child({ correlationId: req.id });
//       const t0 = Date.now();
//       requireApiAuth(req);

//       const parsed = ChatRequestSchema.safeParse(req.body);
//       if (!parsed.success) {
//         reqLog.warn({ issues: parsed.error.issues }, "chat_validation_failed");
//         return reply.code(400).send({ error: "invalid_request", issues: parsed.error.issues });
//       }

//       const reqBody = parsed.data;
//       reqLog.info(
//         { machineId: reqBody.machineId ?? "(none)", messageCount: reqBody.messages.length, tagIds: reqBody.tagIds ?? [] },
//         "chat_request_received"
//       );

//       if (reqBody.machineId) validateMachineAccess(reqBody.machineId);

//       const lastUser = [...reqBody.messages].reverse().find(m => m.role === "user");
//       if (!lastUser) return reply.code(400).send({ error: "no_user_message" });

//       reqLog.info({ query: lastUser.content.slice(0, 120) }, "chat_user_query");

//       const tFetch = Date.now();
//       const machineId = reqBody.machineId || "lamination-01";
//       const isGreeting = isGreetingLike(lastUser.content);
//       const intent = resolveIntent(lastUser.content, reqBody.tagIds);
//       const useToolPipeline = wantsToolPipeline(lastUser.content, reqBody.tagIds) && !isGreeting;

//       const ragPromise = ragQuery({
//         query: lastUser.content,
//         machineId: reqBody.machineId,
//         tagIds: reqBody.tagIds,
//         topK: config.ragTopK,
//       }).catch(err => {
//         reqLog.warn({ err: String(err) }, "rag_query_failed");
//         return [] as { text: string; chunkId: string; sourceUri?: string }[];
//       });

//       let ragContexts: { text: string; chunkId: string; sourceUri?: string }[] = [];
//       let liveContexts: { source: string; text: string }[] = [];
//       let toolBlocks: { name: string; text: string }[] = [];
//       let findCandidates: FindTagCandidate[] = [];
//       let plannerRaw = "";
//       let plannerCalls: ChatToolCall[] = [];
//       let plannerMs = 0;
//       let toolsExecMs = 0;

//       if (useToolPipeline) {
//         const runTools = async () => {
//           const tP = Date.now();
//           const plannerUser = `User machineId: "${machineId}"\nUser message:\n${lastUser.content}`;
//           plannerRaw = await chatOnceWithModel(
//             [
//               { role: "system", content: PLANNER_SYSTEM },
//               { role: "user", content: plannerUser },
//             ],
//             config.ollamaModel,
//             { numCtx: config.ollamaNumCtx, temperature: 0, topP: config.ollamaTopP, repeatPenalty: config.ollamaRepeatPenalty }
//           );
//           plannerMs = Date.now() - tP;
//           const plan = parsePlannerJson(plannerRaw);
//           const calls: ChatToolCall[] =
//             plan?.tools?.length && plan.tools.length > 0
//               ? (plan.tools as ChatToolCall[])
//               : defaultToolPlan(lastUser.content, reqBody.tagIds);
//           plannerCalls = calls;
//           const tExec = Date.now();
//           const out = await runToolPlan(machineId, calls);
//           toolsExecMs = Date.now() - tExec;
//           return out;
//         };

//         const [ragRes, toolOut] = await Promise.all([ragPromise, runTools()]);
//         ragContexts = ragRes;
//         toolBlocks = toolOut.blocks;
//         findCandidates = toolOut.findCandidates;
//         liveContexts = toolBlocksToLiveContexts(toolBlocks);
//       } else {
//         const [ragRes, liveRes] = await Promise.all([
//           ragPromise,
//           fetchLiveContext(lastUser.content, machineId, { tagIds: reqBody.tagIds }).catch(err => {
//             reqLog.warn({ err: String(err) }, "live_context_failed");
//             return [] as { source: string; text: string }[];
//           }),
//         ]);
//         ragContexts = ragRes;
//         liveContexts = liveRes;
//       }

//       const fetchMs = Date.now() - tFetch;
//       const hasLiveTags = liveContexts.some(c => c.source === "tags_db" || c.source === "tags_selected");
//       const hasContext = ragContexts.length > 0 || liveContexts.length > 0;

//       reqLog.info(
//         {
//           fetchMs,
//           toolPipeline: useToolPipeline,
//           intent,
//           ragChunks: ragContexts.length,
//           hasTagContext: hasLiveTags,
//           liveSources: liveContexts.map(c => c.source),
//         },
//         "context_retrieval_done"
//       );

//       // ── Build MachineContext and pre-render ─────────────────────────
//       const capturedAt = new Date().toLocaleTimeString("en-IN", {
//         timeZone: "Asia/Kolkata",
//         hour: "2-digit",
//         minute: "2-digit",
//       });

//       const machineCtx = buildMachineContext(machineId, liveContexts, capturedAt);
//       const pre = preRender(machineCtx, intent);

//       // ── Build LLM prompt ────────────────────────────────────────────
//       // Tool pipeline: use two-phase rendering (compact brief → narrative)
//       // RAG-only path: use legacy system prompt for document-grounded answers
//       const useTwoPhase = useToolPipeline && hasLiveTags && !isGreeting;
//       const system = useTwoPhase
//         ? buildLlmPrompt(pre.llmBrief, intent, lastUser.content)
//         : buildRagSystemPrompt(ragContexts, liveContexts);

//       const messages = reqBody.messages.filter(m => m.role !== "system").slice(-8);

//       reqLog.info(
//         {
//           model: config.ollamaModel,
//           historyMsgs: messages.length,
//           systemPromptLen: system.length,
//           hasContext,
//           useTwoPhase,
//           intent,
//         },
//         "llm_request_starting"
//       );

//       let answer: string;
//       const tLlm = Date.now();
//       try {
//         answer = await chatOnce([{ role: "system", content: system }, ...messages]);
//       } catch (err) {
//         reqLog.error({ err: String(err), llmMs: Date.now() - tLlm }, "llm_chat_failed");
//         return reply.code(503).send({ error: "llm_unavailable" });
//       }
//       const llmMs = Date.now() - tLlm;

//       // ── Post-processing ─────────────────────────────────────────────

//       if (hasContext && ragContexts.length > 0) {
//         answer = needsCitationGuard(answer, ragContexts.length);
//       }

//       // Two-phase: assemble deterministic blocks + LLM narrative
//       if (useTwoPhase) {
//         answer = assembleFinalAnswer(answer, pre, intent);
//       }

//       // Hallucination guard: only fires on 3+ unknown tag slugs
//       if (hasLiveTags && !isGreeting) {
//         const allowed = extractLiveTagSlugs(liveContexts);
//         if (allowed.size > 0) {
//           const mentioned = extractMentionedSlugs(answer);
//           const unknown = [...mentioned].filter(m => !allowed.has(m));
//           if (unknown.length >= 3) {
//             reqLog.warn({ unknownSlugs: unknown.slice(0, 8) }, "llm_tag_hallucination_guard_applied");
//             answer = buildHumanizedFallback(machineCtx);
//           }
//         }
//       }

//       answer = stripInternalHeaders(answer);

//       reqLog.info(
//         {
//           llmMs,
//           totalMs: Date.now() - t0,
//           answerLen: answer.length,
//           answerPreview: answer.slice(0, 150),
//           grounded: hasContext,
//           useTwoPhase,
//           intent,
//         },
//         "chat_response_ready"
//       );

//       reply.header("x-correlation-id", req.id);

//       // ── Build steps ─────────────────────────────────────────────────
//       const steps: { tool: string; label: string; durationMs: number }[] = [];
//       if (ragContexts.length > 0) {
//         steps.push({ tool: "rag_search", label: `Searched ${ragContexts.length} documents`, durationMs: fetchMs });
//       }
//       if (useToolPipeline) {
//         steps.push({ tool: "planner", label: "Planned tool calls", durationMs: plannerMs });
//         const perToolMs = toolBlocks.length > 0 ? Math.max(1, Math.round(toolsExecMs / toolBlocks.length)) : toolsExecMs;
//         for (const b of toolBlocks) {
//           const label =
//             b.name === "find_tags" ? "Resolved tag candidates (fuzzy)"
//               : b.name === "get_tags" ? "Fetched live tag values"
//                 : b.name === "get_alerts" ? "Queried alerts"
//                   : b.name === "get_reports" ? "Loaded report runs"
//                     : b.name === "get_production_metrics" ? "Aggregated production metrics"
//                       : `Ran tool ${b.name}`;
//           steps.push({ tool: b.name, label, durationMs: perToolMs });
//         }
//       } else {
//         for (const lc of liveContexts) {
//           const label =
//             lc.source === "alerts_db" ? "Queried alerts"
//               : lc.source === "tags_db" ? "Fetched live tag values"
//                 : lc.source === "tags_selected" ? "Loaded selected tags"
//                   : lc.source === "reports_db" ? "Loaded report history"
//                     : lc.source === "ollama_catalog" ? "Listed available models"
//                       : `Queried ${lc.source}`;
//           steps.push({ tool: lc.source, label, durationMs: fetchMs });
//         }
//       }
//       steps.push({ tool: "llm", label: `Generated response (${config.ollamaModel})`, durationMs: llmMs });

//       // ── Build response payload ───────────────────────────────────────
//       const tagBlocks = liveContexts.filter(c => c.source === "tags_db" || c.source === "tags_selected");
//       const liveTagLineCount = tagBlocks.reduce((n, c) => n + (c.text.match(/\n/g)?.length ?? 0) + 1, 0);

//       const contextBlocks = liveContexts
//         .filter(c => c.source !== "tool_find_tags")
//         .map(c => ({
//           source: c.source,
//           preview: c.text.length > 600 ? `${c.text.slice(0, 600)}…` : c.text,
//         }));

//       const ranFindTags = toolBlocks.some(b => b.name === "find_tags");
//       const findCandidatesOut =
//         useToolPipeline && ranFindTags && findCandidates.length > 0
//           ? findCandidates.slice(0, 12).map(c => ({
//             tagId: c.tagId,
//             slug: c.slug,
//             name: c.name,
//             unit: c.unit,
//             score: c.score,
//           }))
//           : undefined;

//       return reply.send({
//         answer,
//         grounded: hasContext,
//         health: machineCtx.meta.overallHealth,
//         steps,
//         citations: ragContexts.map((c, i) => ({ index: i + 1, chunkId: c.chunkId, sourceUri: c.sourceUri ?? null })),
//         contextBlocks,
//         liveTagCount: tagBlocks.length > 0 ? liveTagLineCount : undefined,
//         toolPlan: useToolPipeline ? { raw: plannerRaw, tools: plannerCalls } : undefined,
//         findCandidates: findCandidatesOut,
//       });
//     }
//   );
// }
import type { FastifyInstance } from "fastify";
import { ChatRequestSchema } from "@rvl/shared";
import { requireApiAuth, validateMachineAccess } from "../auth.js";
import { ragQuery } from "../rag/store.js";
import { chatOnce, chatOnceWithModel } from "../llm/ollama.js";
import { config } from "../config.js";
import { fetchLiveContext } from "./chatContext.js";
import {
  defaultToolPlan,
  parsePlannerJson,
  PLANNER_SYSTEM,
  wantsToolPipeline,
} from "../services/chatPlanner.js";
import { runToolPlan, type ChatToolCall, type FindTagCandidate } from "../services/chatTools.js";
import {
  buildChatSessionKey,
  getChatHistoryCached,
  mergeHistoryWithRequest,
  putChatHistoryCached,
  type ChatHistoryMessage,
} from "../services/chatHistoryCache.js";
import {
  normalizeInput,
  detectRisk,
  detectIntent,
  detectMissingContext,
  selectHandler,
  buildContextPacket,
  buildLlmSystemPrompt,
  assembleFinalResponse,
  validateOutput,
  // Fully deterministic handlers (no LLM)
  handleGreeting,
  handleEscalation,
  handleUnsafeInput,
  handleOutOfScope,
  handleAmbiguous,
  handleNoContext,
  handleToolFailure,
  type HandlerType,
} from "../handlers/chatHandler.js";

/* ─────────────────────────────────────────────────────────────────
   UTILITY
   ───────────────────────────────────────────────────────────────── */

function toolBlocksToLiveContexts(
  toolBlocks: { name: string; text: string }[]
): { source: string; text: string }[] {
  return toolBlocks
    .filter(b => b.name !== "find_tags")
    .map(b => ({
      source:
        b.name === "get_tags" ? "tags_db"
          : b.name === "get_alerts" ? "alerts_db"
            : b.name === "get_reports" ? "reports_db"
              : b.name === "get_production_metrics" ? "production_db"
                : `tool_${b.name}`,
      text: b.text,
    }));
}

function deriveHealth(
  liveContexts: { source: string; text: string }[]
): "healthy" | "degraded" | "critical" | "unknown" {
  const alertBlock = liveContexts.find(c => c.source === "alerts_db");
  const tagBlock = liveContexts.find(c => c.source === "tags_db" || c.source === "tags_selected");

  if (!tagBlock && !alertBlock) return "unknown";

  if (alertBlock && alertBlock.text) {
    if (/\[CRITICAL\].*status:\s*open/i.test(alertBlock.text)) return "critical";
    if (/\[WARNING\].*status:\s*open/i.test(alertBlock.text)) return "degraded";
  }

  if (tagBlock && tagBlock.text) {
    // Check for active fault flags
    if (/:\s*1\s*\[/.test(tagBlock.text) && /(FAULT|ALARM_IND|EMG_STOP)/.test(tagBlock.text)) {
      return "degraded";
    }
  }

  if (tagBlock && tagBlock.text && !tagBlock.text.includes("No tags found")) return "healthy";

  return "unknown";
}

function needsCitationGuard(answer: string, ragCount: number): string {
  if (ragCount === 0) return answer;
  if (/\[#\d+\]/.test(answer)) return answer;
  return `${answer}\n\n_No document citations detected — verify critical values against primary systems._`;
}

/**
 * Prevent contradictory fallback text when tool data actually exists.
 * If we already have live context, never allow "can't access live data" style answers.
 */
function replaceUngroundedNoDataClaims(
  answer: string,
  hasLiveData: boolean,
  groundedFallback: string
): string {
  if (!hasLiveData) return answer;
  const badClaimPattern =
    /\b(tool[_\s-]*pipeline.*did(?:\s+not|n't)\s+respond|unable(?:\s+at\s+this\s+moment)?|cannot\s+provide.*real[-\s]*time|can't\s+provide.*live\s+data|try\s+again\s+later.*live\s+data|i\s+don't\s+have\s+enough\s+data\s+to\s+answer\s+that\s+right\s+now|no\s+(additional\s+)?production\s+data|halts?\s+production\s+operations?|no\s+further\s+production\s+data\s+can\s+be\s+provided)\b/i;
  return badClaimPattern.test(answer) ? groundedFallback : answer;
}

function buildAvailableDataFallback(
  liveContexts: { source: string; text: string }[],
  health: "healthy" | "degraded" | "critical" | "unknown"
): string {
  const hasTags = liveContexts.some(c => c.source === "tags_db" || c.source === "tags_selected");
  const hasAlerts = liveContexts.some(c => c.source === "alerts_db");
  const hasReports = liveContexts.some(c => c.source === "reports_db");
  const hasProduction = liveContexts.some(c => c.source === "production_db");
  const parts: string[] = [];

  if (hasAlerts) parts.push("alerts");
  if (hasTags) parts.push("tag readings");
  if (hasProduction) parts.push("production metrics");
  if (hasReports) parts.push("report history");

  if (parts.length === 0) {
    return "I couldn't extract a reliable machine summary from the current context. Please ask for alerts, tags, or production metrics explicitly.";
  }

  const joined = parts.length === 1
    ? parts[0]
    : `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}`;

  return `Live data available: ${joined}. Current machine health: ${health}.`;
}

/* ─────────────────────────────────────────────────────────────────
   ROUTE REGISTRATION
   ───────────────────────────────────────────────────────────────── */

export async function registerChatRoutes(app: FastifyInstance) {
  const chatRate = (app as any).rateLimit?.bind(app);
  const chatRateHandler = chatRate
    ? chatRate({
      max: config.chatRateLimitMax,
      timeWindow: "1 minute",
      keyGenerator: (request: any) => {
        const auth = request.headers["authorization"] ?? request.headers["Authorization"] ?? "";
        const a = Array.isArray(auth) ? auth[0] : auth;
        return `${request.ip}|${String(a ?? "").slice(0, 64)}`;
      },
    })
    : undefined;

  app.post(
    "/chat",
    chatRateHandler ? { preHandler: [chatRateHandler] } : {},
    async (req, reply) => {
      const reqLog = req.log.child({ correlationId: req.id });
      const t0 = Date.now();
      requireApiAuth(req);

      // ── Validate request ─────────────────────────────────────────
      const parsed = ChatRequestSchema.safeParse(req.body);
      if (!parsed.success) {
        reqLog.warn({ issues: parsed.error.issues }, "chat_validation_failed");
        return reply.code(400).send({ error: "invalid_request", issues: parsed.error.issues });
      }

      const reqBody = parsed.data;
      reqLog.info(
        {
          machineId: reqBody.machineId ?? "(none)",
          messageCount: reqBody.messages.length,
          tagIds: reqBody.tagIds ?? [],
        },
        "chat_request_received"
      );

      if (reqBody.machineId) validateMachineAccess(reqBody.machineId);
      const machineId = reqBody.machineId || "lamination-01";
      const rawAuth = req.headers["authorization"] ?? req.headers["Authorization"] ?? "";
      const authHeader = Array.isArray(rawAuth) ? rawAuth[0] : rawAuth;
      const rawSession = req.headers["x-chat-session-id"];
      const sessionHeader = Array.isArray(rawSession) ? rawSession[0] : rawSession;
      const sessionKey = buildChatSessionKey({
        machineId,
        explicitSessionId: typeof sessionHeader === "string" ? sessionHeader : null,
        authHeader: typeof authHeader === "string" ? authHeader : null,
        ip: req.ip,
      });
      const cachedHistory = getChatHistoryCached(sessionKey);

      const lastUser = [...reqBody.messages].reverse().find(m => m.role === "user");
      if (!lastUser) return reply.code(400).send({ error: "no_user_message" });

      reqLog.info({ query: lastUser.content.slice(0, 120) }, "chat_user_query");

      // ── PIPELINE STEP 1: Normalize input ─────────────────────────
      const normalized = normalizeInput(lastUser.content);

      // ── PIPELINE STEP 2: Risk detection ──────────────────────────
      const risk = detectRisk(normalized);

      if (risk.block) {
        reqLog.warn({ reason: risk.reason }, "chat_blocked_unsafe_input");
        return reply.send({
          answer: handleUnsafeInput(),
          grounded: false,
          health: "unknown",
          steps: [],
          citations: [],
          contextBlocks: [],
        });
      }

      // ── PIPELINE STEP 3: Intent detection ────────────────────────
      const previousQuery = reqBody.messages.length >= 2
        ? reqBody.messages[reqBody.messages.length - 2]?.content
        : undefined;
      const intent = detectIntent(normalized, previousQuery);

      // ── Short-circuit: fully deterministic handlers ───────────────
      if (intent.isGreeting) {
        return reply.send({
          answer: handleGreeting("RVL Laminator"),
          grounded: false,
          health: "unknown",
          steps: [],
          citations: [],
          contextBlocks: [],
        });
      }

      if (intent.isEscalation) {
        return reply.send({
          answer: handleEscalation(),
          grounded: false,
          health: "unknown",
          steps: [],
          citations: [],
          contextBlocks: [],
        });
      }

      if (intent.isOutOfScope) {
        return reply.send({
          answer: handleOutOfScope(),
          grounded: false,
          health: "unknown",
          steps: [],
          citations: [],
          contextBlocks: [],
        });
      }

      const useToolPipeline = wantsToolPipeline(lastUser.content, reqBody.tagIds) && !intent.isGreeting;

      // ── Fetch context ─────────────────────────────────────────────
      const tFetch = Date.now();

      const ragPromise = ragQuery({
        query: lastUser.content,
        machineId: reqBody.machineId,
        tagIds: reqBody.tagIds,
        topK: config.ragTopK,
      }).catch(err => {
        reqLog.warn({ err: String(err) }, "rag_query_failed");
        return [] as { text: string; chunkId: string; sourceUri?: string }[];
      });

      let ragContexts: { text: string; chunkId: string; sourceUri?: string }[] = [];
      let liveContexts: { source: string; text: string }[] = [];
      let toolBlocks: { name: string; text: string }[] = [];
      let findCandidates: FindTagCandidate[] = [];
      let plannerRaw = "";
      let plannerCalls: ChatToolCall[] = [];
      let plannerMs = 0;
      let toolsExecMs = 0;

      if (useToolPipeline) {
        const runTools = async () => {
          const tP = Date.now();
          const plannerUser = `Machine ID: "${machineId}"\nUser query: ${normalized.clean}`;
          let plannerOutput = "";
          try {
            plannerOutput = await chatOnceWithModel(
              [
                { role: "system", content: PLANNER_SYSTEM },
                { role: "user", content: plannerUser },
              ],
              config.ollamaModel,
              {
                numCtx: config.ollamaNumCtx,
                temperature: 0,
                topP: config.ollamaTopP,
                repeatPenalty: config.ollamaRepeatPenalty,
              }
            );
          } catch (err) {
            reqLog.warn({ err: String(err) }, "planner_llm_failed");
          }
          plannerRaw = plannerOutput;
          plannerMs = Date.now() - tP;

          const plan = parsePlannerJson(plannerRaw);
          const calls: ChatToolCall[] =
            plan?.tools?.length && plan.tools.length > 0
              ? plan.tools
              : defaultToolPlan(lastUser.content, reqBody.tagIds);

          plannerCalls = calls;

          const tExec = Date.now();
          let out: Awaited<ReturnType<typeof runToolPlan>>;
          try {
            out = await runToolPlan(machineId, calls);
          } catch (err) {
            reqLog.warn({ err: String(err) }, "tool_plan_exec_failed");
            out = { blocks: [], findCandidates: [] };
          }
          toolsExecMs = Date.now() - tExec;
          return out;
        };

        const [ragRes, toolOut] = await Promise.all([ragPromise, runTools()]);
        ragContexts = ragRes;
        toolBlocks = toolOut.blocks;
        findCandidates = toolOut.findCandidates;
        liveContexts = toolBlocksToLiveContexts(toolBlocks);
      } else {
        const [ragRes, liveRes] = await Promise.all([
          ragPromise,
          fetchLiveContext(lastUser.content, machineId, { tagIds: reqBody.tagIds }).catch(err => {
            reqLog.warn({ err: String(err) }, "live_context_failed");
            return [] as { source: string; text: string }[];
          }),
        ]);
        ragContexts = ragRes;
        liveContexts = liveRes;
      }

      const fetchMs = Date.now() - tFetch;
      const hasLiveTags = liveContexts.some(
        c => c.source === "tags_db" || c.source === "tags_selected"
      );
      const hasLiveData = liveContexts.length > 0;

      reqLog.info(
        {
          fetchMs,
          toolPipeline: useToolPipeline,
          ragChunks: ragContexts.length,
          hasTagContext: hasLiveTags,
          liveSources: liveContexts.map(c => c.source),
        },
        "context_retrieval_done"
      );

      // ── PIPELINE STEP 4: Detect missing context ───────────────────
      const ctxAssessment = detectMissingContext(liveContexts, intent);

      // ── PIPELINE STEP 5: Select handler ──────────────────────────
      const handlerDecision = selectHandler(normalized, risk, intent, ctxAssessment);

      reqLog.info(
        { handler: handlerDecision.handler, reason: handlerDecision.reason },
        "handler_selected"
      );

      // Short-circuit: handler has a deterministic fallback answer
      if (!handlerDecision.requiresLlm && handlerDecision.fallbackAnswer) {
        return reply.send({
          answer: handlerDecision.fallbackAnswer,
          grounded: false,
          health: deriveHealth(liveContexts),
          steps: [{ tool: "handler", label: handlerDecision.handler, durationMs: Date.now() - t0 }],
          citations: [],
          contextBlocks: [],
          handler: handlerDecision.handler,
        });
      }

      // No-context edge case
      if (handlerDecision.handler === "no_context" && !handlerDecision.requiresLlm) {
        return reply.send({
          answer: handleNoContext(),
          grounded: false,
          health: "unknown",
          steps: [],
          citations: [],
          contextBlocks: [],
        });
      }

      // ── PIPELINE STEP 6: Build context packet ────────────────────
      const capturedAt = new Date().toLocaleTimeString("en-IN", {
        timeZone: "Asia/Kolkata",
        hour: "2-digit",
        minute: "2-digit",
      });

      const health = deriveHealth(liveContexts);

      const contextPacket = buildContextPacket(
        handlerDecision,
        normalized,
        intent,
        ctxAssessment,
        liveContexts,
        machineId,
        capturedAt,
        health
      );

      // ── PIPELINE STEP 7: Build LLM prompt ────────────────────────
      // Tool pipeline with live tags → compact two-phase prompt
      // RAG-only or no tags → legacy document-grounded prompt
      const useTwoPhase = useToolPipeline && hasLiveData;

      let system: string;
      if (useTwoPhase) {
        system = buildLlmSystemPrompt(contextPacket);
      } else {
        // Legacy RAG-only system prompt
        system = buildRagSystemPrompt(ragContexts, liveContexts, handlerDecision.handler);
      }

      const mergedHistory = mergeHistoryWithRequest(
        reqBody.messages,
        cachedHistory?.machineId === machineId ? cachedHistory.messages : [],
        12
      );
      const messages = mergedHistory.slice(-8);

      reqLog.info(
        {
          model: config.ollamaModel,
          historyMsgs: messages.length,
          cachedHistoryMsgs: cachedHistory?.messages.length ?? 0,
          systemPromptLen: system.length,
          useTwoPhase,
          handler: handlerDecision.handler,
        },
        "llm_request_starting"
      );

      // ── PIPELINE STEP 7: LLM call ─────────────────────────────────
      let rawAnswer: string;
      const tLlm = Date.now();
      try {
        rawAnswer = await chatOnce([{ role: "system", content: system }, ...messages]);
      } catch (err) {
        reqLog.error({ err: String(err), llmMs: Date.now() - tLlm }, "llm_chat_failed");
        // Use deterministic fallback — do NOT fail the request
        rawAnswer = "";
      }
      const llmMs = Date.now() - tLlm;

      // ── PIPELINE STEP 8: Validate LLM output ─────────────────────
      const validation = validateOutput(rawAnswer, contextPacket, liveContexts);

      if (!validation.valid) {
        reqLog.warn(
          { reason: validation.reason, handler: handlerDecision.handler },
          "llm_output_failed_validation"
        );
      }

      const narrative = validation.valid ? validation.cleaned : contextPacket.fallback;

      // ── PIPELINE STEP 9: Assemble final answer ────────────────────
      let answer: string;

      if (useTwoPhase) {
        answer = assembleFinalResponse(narrative, contextPacket, handlerDecision);
      } else {
        // RAG path: just clean and guard
        answer = validation.valid ? validation.cleaned : contextPacket.fallback;
        if (ragContexts.length > 0) {
          answer = needsCitationGuard(answer, ragContexts.length);
        }
      }

      // If tools returned live context, block contradictory "no live data" wording.
      answer = replaceUngroundedNoDataClaims(
        answer,
        hasLiveData,
        buildAvailableDataFallback(liveContexts, health)
      );

      // Final length guard — if still empty, use fallback
      if (!answer || answer.trim().length < 5) {
        answer = contextPacket.fallback;
      }

      reqLog.info(
        {
          llmMs,
          totalMs: Date.now() - t0,
          answerLen: answer.length,
          answerPreview: answer.slice(0, 150),
          grounded: ragContexts.length > 0 || hasLiveData,
          useTwoPhase,
          handler: handlerDecision.handler,
          validationOk: validation.valid,
        },
        "chat_response_ready"
      );

      const now = Date.now();
      const historyToPersist: ChatHistoryMessage[] = [
        ...(cachedHistory?.machineId === machineId ? cachedHistory.messages : []),
        { role: "user", content: lastUser.content, timestamp: now },
        { role: "assistant", content: answer, timestamp: now },
      ];
      try {
        putChatHistoryCached(sessionKey, machineId, historyToPersist, now);
      } catch (err) {
        reqLog.warn({ err: String(err), sessionKey }, "chat_history_cache_write_failed");
      }

      reply.header("x-correlation-id", req.id);

      // ── Build steps for UI ────────────────────────────────────────
      const steps: { tool: string; label: string; durationMs: number }[] = [];

      if (ragContexts.length > 0) {
        steps.push({
          tool: "rag_search",
          label: `Searched ${ragContexts.length} documents`,
          durationMs: fetchMs,
        });
      }

      if (useToolPipeline) {
        steps.push({ tool: "planner", label: "Planned tool calls", durationMs: plannerMs });
        const perToolMs = toolBlocks.length > 0
          ? Math.max(1, Math.round(toolsExecMs / toolBlocks.length))
          : toolsExecMs;
        for (const b of toolBlocks) {
          steps.push({
            tool: b.name,
            label: TOOL_LABEL[b.name] ?? `Ran tool ${b.name}`,
            durationMs: perToolMs,
          });
        }
      } else {
        for (const lc of liveContexts) {
          steps.push({
            tool: lc.source,
            label: LIVE_CONTEXT_LABEL[lc.source] ?? `Queried ${lc.source}`,
            durationMs: fetchMs,
          });
        }
      }

      steps.push({
        tool: "llm",
        label: `Generated response (${config.ollamaModel})`,
        durationMs: llmMs,
      });

      // ── Build response payload ────────────────────────────────────
      const tagBlocks = liveContexts.filter(
        c => c.source === "tags_db" || c.source === "tags_selected"
      );
      const liveTagLineCount = tagBlocks.reduce(
        (n, c) => n + (c.text.match(/\n/g)?.length ?? 0) + 1,
        0
      );

      const contextBlocks = liveContexts
        .filter(c => c.source !== "tool_find_tags")
        .map(c => ({
          source: c.source,
          preview: c.text.length > 600 ? `${c.text.slice(0, 600)}…` : c.text,
        }));

      const ranFindTags = toolBlocks.some(b => b.name === "find_tags");
      const findCandidatesOut =
        useToolPipeline && ranFindTags && findCandidates.length > 0
          ? findCandidates.slice(0, 12).map(c => ({
            tagId: c.tagId,
            slug: c.slug,
            name: c.name,
            unit: c.unit,
            score: c.score,
          }))
          : undefined;

      return reply.send({
        answer,
        grounded: ragContexts.length > 0 || hasLiveData,
        health,
        handler: handlerDecision.handler,
        steps,
        citations: ragContexts.map((c, i) => ({
          index: i + 1,
          chunkId: c.chunkId,
          sourceUri: c.sourceUri ?? null,
        })),
        contextBlocks,
        liveTagCount: tagBlocks.length > 0 ? liveTagLineCount : undefined,
        toolPlan: useToolPipeline
          ? { raw: plannerRaw, tools: plannerCalls }
          : undefined,
        findCandidates: findCandidatesOut,
      });
    }
  );
}

/* ─────────────────────────────────────────────────────────────────
   LEGACY RAG SYSTEM PROMPT
   Used when the tool pipeline is off (document-grounded path).
   ───────────────────────────────────────────────────────────────── */

function buildRagSystemPrompt(
  ragContexts: { text: string; chunkId: string; sourceUri?: string }[],
  liveContexts: { source: string; text: string }[],
  handler: HandlerType
): string {
  const hasAny = ragContexts.length > 0 || liveContexts.length > 0;

  const handlerHint = RAG_HANDLER_HINTS[handler] ?? "";

  const persona = `You are Ravi, the RVL Lamination Assistant — calm, experienced, direct. Speak plainly. Lead with the answer. Use exact values from CONTEXT. Never invent data. Never end with hollow closings. Write 2-4 sentences only.${handlerHint ? "\n" + handlerHint : ""}`;

  if (!hasAny) {
    return `${persona}\n\nCONTEXT:\n(empty — no live data available right now)`;
  }

  const parts: string[] = [];

  if (liveContexts.length > 0) {
    const clean = liveContexts.filter(
      c => !c.text.includes("No definitions matched") && !c.text.includes("No tags found")
    );
    parts.push(...(clean.length > 0 ? clean : liveContexts).map(c => c.text));
  }

  if (ragContexts.length > 0) {
    parts.push(...ragContexts.map((c, i) => `[#${i + 1}] ${c.text}`));
  }

  return `${persona}\n\nCONTEXT:\n${parts.join("\n\n")}`;
}

const RAG_HANDLER_HINTS: Partial<Record<HandlerType, string>> = {
  alerts: "Focus on the alert situation. Name the most important alert first.",
  stale_data: "Note that data may be stale. Do not state readings as current fact.",
  partial_telemetry: "Acknowledge that only partial data is available.",
  user_correction: "Acknowledge the correction. Re-state the current data clearly.",
  conflicting_context: "Flag the discrepancy between fault flags and alert records.",
};

const TOOL_LABEL: Record<string, string> = {
  find_tags: "Resolved tag candidates (fuzzy)",
  get_tags: "Fetched live tag values",
  get_alerts: "Queried alerts",
  get_reports: "Loaded report runs",
  get_production_metrics: "Aggregated production metrics",
};

const LIVE_CONTEXT_LABEL: Record<string, string> = {
  alerts_db: "Queried alerts",
  tags_db: "Fetched live tag values",
  tags_selected: "Loaded selected tags",
  reports_db: "Loaded report history",
  ollama_catalog: "Listed available models",
  production_db: "Aggregated production data",
};