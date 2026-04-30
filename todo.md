You are a production-grade backend software engineer specializing in Industrial IoT systems, real-time data pipelines, and AI-powered chat agents. You are building the backend for a **Nonwoven Lamination Machine Monitoring Platform**.

---

## TECH STACK

- **Runtime**: Node.js (TypeScript)
- **Framework**: Fastify
- **ORM / DB clients**:
  - `drizzle-orm` with PostgreSQL (for alerts, reports, deliveries — see Drizzle schema below)
  - `@prisma/client` with MongoDB (for tags, machine profiles, tag definitions, tag samples — see Prisma schema below)
- **AI**: Google Gemini (`@google/generative-ai`) — use `gemini-2.0-flash` model
- **Chat History Storage**: PostgreSQL via Drizzle (you will design the chat tables)
- **Env vars**: loaded via `dotenv`

---

## MACHINE CONTEXT

This system monitors a **Nonwoven Lamination Machine** (`machineId: "lamination-01"`, `machineRevision: "v1"`). The machine has three main subsystems:

### Extruder
- Melts and extrudes polymer resin
- Key tags: `EXTRUDER_RPM`, `EXTRUDER_AMP`, `EXTRUDER_SPEED_PCT`, `EXTRUDER_SPEED_VOL`, `EXTRUDER_ON_OFF`, `EXTRUDER_FAULT`
- Normal RPM range: 0–120 RPM (nominal ~85). Warn >80, Alarm >100
- Normal Amps: warn >35A, alarm >40A

### Laminator
- Bonds layers of film/fabric together using heat and pressure
- Key tags: `LAMINATOR_MPM`, `LAMINATOR_AMP`, `LAMINATOR_SPEED_PCT`, `LAMINATOR_SPEED_VOL`, `LAMINATOR_ON_OFF`, `LAMINATOR_FAULT`
- Normal speed: 20–80 m/min (nominal ~55). Warn >130, Alarm >150 m/min
- Normal Amps: warn >12A, alarm >15A

### Winder
- Winds finished laminated product onto rolls
- Key tags: `WINDER_AMP`, `WINDER_TENSION_PCT`, `WINDER_TENSION_VOL`, `WINDER_ON_OFF`, `WINDER_FAULT`
- Tension warn >80%, alarm >90%
- Amps: warn >8A, alarm >12A

### Production / Line
- `MASTER_SPEED_PCT` — overall line speed
- `RUNNING_METER` — meters produced this roll/session (accumulator)
- `TOTAL_METER` — lifetime production meters (accumulator)
- `GSM_ENTRY` — grams per square meter (product weight, 10–100 g/m²)
- `GRAM_ENTRY` — gram weight entry (50–500g)
- `UW_SET_TENSION` / `UW_PV_TENSION` — unwinder tension setpoint vs actual (in Newtons)
- `SPLICE_ON_OFF` / `SPLICE_SPEED` — splice operation status and speed

### Safety / Alarms
- `EMG_STOP` — emergency stop active (bool) — CRITICAL
- `ALARM_IND` — general alarm indicator (bool)
- `EXTRUDER_FAULT`, `LAMINATOR_FAULT`, `WINDER_FAULT` — subsystem faults (bool)

---

## DATA PIPELINE (how data flows in)

A Raspberry Pi runs a Modbus TCP poller (`a.py`) that:
1. Polls the PLC every 500ms via Modbus TCP
2. Every 5 seconds, POSTs a batch to `POST /ingest/tags`
3. Payload format:
```json
{
  "machineId": "lamination-01",
  "machineRevision": "v1",
  "sentAt": "2025-01-01T00:00:00.000Z",
  "seq": 42,
  "tags": [
    { "tagSlug": "EXTRUDER_RPM", "value": 85.2, "ts": "2025-01-01T00:00:00.000Z" },
    { "tagSlug": "LAMINATOR_MPM", "value": 54.7, "ts": "2025-01-01T00:00:00.000Z" },
    { "tagSlug": "WINDER_TENSION_PCT", "value": 50, "ts": "2025-01-01T00:00:00.000Z" },
    { "tagSlug": "EMG_STOP", "value": false, "ts": "2025-01-01T00:00:00.000Z" }
  ]
}
```
4. Tags use `tagSlug` (e.g. `"EXTRUDER_RPM"`), NOT tagId
5. The ingest handler resolves `tagSlug → tagId` by looking up `TagDefinition` in MongoDB
6. It upserts `TagLatest` and inserts `TagSample` records in MongoDB
7. It also checks thresholds and fires `alertEvents` in PostgreSQL if values cross `warnHigh/alarmHigh/warnLow/alarmLow` from `TagDefinition`

A simulator (`sim.ts`) also exists that sends the same payload format for development/testing.

---

## DATABASE SCHEMAS

### PostgreSQL (Drizzle ORM)

```typescript
// Enums
alertSeverity: "info" | "warning" | "critical"
alertStatus: "open" | "acknowledged" | "resolved"
deliveryChannel: "email" | "webhook"
deliveryStatus: "queued" | "sending" | "sent" | "failed"
reportFormat: "html" | "json"
runStatus: "queued" | "running" | "succeeded" | "failed"

// Tables
alertRules         // id, machineId, name, enabled, severityDefault, condition(jsonb), createdAt, updatedAt
alertEvents        // id, machineId, ruleId, severity, status, title, description, dedupeKey, payload(jsonb), llmAnalysis(jsonb), startsAt, endsAt, createdAt
alertTags          // alertEventId, tagId, tagSnapshot(jsonb), createdAt — PK(alertEventId, tagId)
alertDeliveries    // id, alertEventId, channel, destination, status, attempt, idempotencyKey, lastError, createdAt, sentAt
acknowledgements   // id, alertEventId, actor, note, createdAt
reportTemplates    // id, name, description, format, definition(jsonb), createdAt
reportSchedules    // id, templateId, machineId, timezone, cron, enabled, deliveryTargets(jsonb), createdAt, lastRunAt
reportRuns         // id, scheduleId, templateId, machineId, status, windowStart, windowEnd, startedAt, finishedAt, error, metrics(jsonb), createdAt
reportArtifacts    // id, runId, type, uri, checksum, bytes, createdAt

// Chat tables (YOU MUST CREATE THESE via Drizzle):
chatSessions       // id(text PK), machineId(text), title(text), createdAt, updatedAt, metadata(jsonb)
chatMessages       // id(text PK), sessionId(text FK→chatSessions.id cascade delete), role("user"|"assistant"|"system"), content(text), toolCalls(jsonb), tokenCount(int), createdAt
```

### MongoDB (Prisma)
Tag                // id, tenantId, slug, name, description, unit, dataType, aliases[], parentId, department, engineerEmail, createdAt, updatedAt, archivedAt
MachineProfile     // id, machineId, machineRevision, name, createdAt
MachineIngestState // id, machineId, machineRevision, lastSeq, lastSentAt, updatedAt
TagDefinition      // id, machineId, machineRevision, tagId, slug, name, unit, dataType, deadband, min, max, maxRatePerSec, sampleEveryMs, staleAfterMs, warnHigh, warnLow, alarmHigh, alarmLow, department, engineerEmail, createdAt, updatedAt
TagLatest          // id, machineId, tagId, ts, valueNumber, valueBool, valueString, quality, lastSampleAt, updatedAt
TagSample          // id, machineId, tagId, ts, valueNumber, valueBool, valueString, quality

---

## TASK: BUILD `POST /chat` — PRODUCTION GEMINI CHAT AGENT

Implement `POST /chat` as a Fastify route. This is a **conversational AI agent** that helps operators monitor and diagnose the lamination machine.

### Request body:
```typescript
{
  sessionId?: string;       // if omitted, create new session
  machineId?: string;       // default "lamination-01"
  message: string;          // user's message
}
```

### Response body:
```typescript
{
  sessionId: string;
  messageId: string;
  reply: string;
  toolsUsed: string[];
  tokenCount?: number;
}
```

---

## CHAT SESSION & HISTORY

1. If `sessionId` is provided, load all messages from `chatMessages` for that session (ordered by `createdAt ASC`) and pass them to Gemini as conversation history.
2. If no `sessionId`, create a new `chatSessions` row with a generated ID (`cuid()` or `nanoid()`) and auto-generate a title from the first message (truncated to 60 chars).
3. After Gemini replies, insert two rows into `chatMessages`:
   - `role: "user"`, `content: message`
   - `role: "assistant"`, `content: reply`, `toolCalls: [array of tool names used]`
4. Update `chatSessions.updatedAt` on every message.
5. **IMPORTANT**: Trim history to last 50 messages before sending to Gemini to avoid token overflow. Always include the system prompt.

---

## SYSTEM PROMPT FOR GEMINI
You are an expert AI assistant for a Nonwoven Lamination Machine manufacturing plant.
You help operators, engineers, and managers monitor machine health, diagnose issues,
analyze production data, and understand alerts.
Machine: lamination-01 (v1)
Subsystems: Extruder, Laminator, Winder, Unwinder, Splice
You have access to real-time tag data, historical samples, alert events, and machine
definitions via tools. Always use tools to fetch live data before answering questions
about current machine state. Do not guess values — query them.
When analyzing issues:

Check current tag values first
Look at recent alert events
Compare to thresholds in tag definitions
Reason about subsystem interactions (e.g., extruder RPM affects laminator MPM)
Give actionable recommendations

Be concise, technically accurate, and operator-friendly. Use units (RPM, m/min, A, %, N, g/m²).
Flag any safety concerns (EMG_STOP, FAULT tags) immediately.

---

## GEMINI TOOLS (Function Calling)

Register ALL these tools with Gemini using the `tools` parameter. Gemini will call them; you execute them against the DB and return results.

---

### Tool 1: `get_live_tag_values`
Fetch current values for one or more tags.

**Parameters:**
```json
{
  "tags": {
    "type": "array",
    "items": { "type": "string" },
    "description": "Tag names to query. Accepts human-readable names like 'extruder RPM', 'laminator speed', 'winder tension' OR exact slugs like 'EXTRUDER_RPM'. The system resolves names to tagIds automatically."
  },
  "machineId": { "type": "string", "default": "lamination-01" }
}
```

**Implementation:**
- Accept fuzzy/natural-language tag names. Resolve them by querying `TagDefinition` where `machineId = machineId` and matching `name ILIKE %query%` OR `slug = query.toUpperCase()` (case-insensitive slug match).
- For each resolved tagId, fetch `TagLatest` from MongoDB.
- Return: array of `{ tagId, slug, name, unit, value, quality, ts, isStale (ts > staleAfterMs) }`
- If `EMG_STOP` is true or any `*_FAULT` tag is true, prepend a `⚠️ SAFETY ALERT` notice in the result.

---

### Tool 2: `get_all_live_tags`
Fetch ALL current tag values for the machine at once.

**Parameters:**
```json
{
  "machineId": { "type": "string", "default": "lamination-01" }
}
```

**Implementation:**
- Fetch all `TagLatest` records where `machineId = machineId`.
- Join with `TagDefinition` to get `slug`, `name`, `unit`, `warnHigh`, `alarmHigh`, etc.
- Return grouped by subsystem:
```json
  {
    "extruder": [...],
    "laminator": [...],
    "winder": [...],
    "production": [...],
    "safety": [...]
  }
```
- Each tag: `{ slug, name, value, unit, status: "normal"|"warn"|"alarm"|"fault", ts }`
- Compute `status` by comparing value to `warnHigh`/`alarmHigh`/`warnLow`/`alarmLow`.

---

### Tool 3: `get_tag_history`
Fetch time-series samples for a tag.

**Parameters:**
```json
{
  "tag": { "type": "string", "description": "Tag name or slug (fuzzy matched)" },
  "machineId": { "type": "string" },
  "from": { "type": "string", "description": "ISO datetime or relative like '1h', '30m', '24h', '7d'" },
  "to": { "type": "string", "description": "ISO datetime, defaults to now" },
  "limit": { "type": "number", "default": 200 }
}
```

**Implementation:**
- Resolve tag name → tagId via `TagDefinition` (fuzzy name match first, then slug fallback).
- Parse relative times: `"1h"` → `now - 1 hour`, `"30m"` → `now - 30 min`, etc.
- Query `TagSample` where `machineId = machineId AND tagId = tagId AND ts >= from AND ts <= to` ordered by `ts ASC`, limit by `limit`.
- Return: `{ tag: { slug, name, unit }, samples: [{ ts, value }], count, from, to }`
- Also compute: `min`, `max`, `avg`, `stdDev` of values in range.

---

### Tool 4: `get_active_alerts`
Fetch currently open or recently triggered alerts.

**Parameters:**
```json
{
  "machineId": { "type": "string" },
  "status": { "type": "string", "enum": ["open", "acknowledged", "resolved", "all"], "default": "open" },
  "severity": { "type": "string", "enum": ["info", "warning", "critical", "all"], "default": "all" },
  "limit": { "type": "number", "default": 20 }
}
```

**Implementation:**
- Query `alertEvents` in PostgreSQL where `machineId = machineId`.
- Filter by `status` (if not "all") and `severity` (if not "all").
- Order by `startsAt DESC`, apply limit.
- Join with `alertTags` to include which tags triggered each alert.
- Return: array of `{ id, severity, status, title, description, startsAt, endsAt, durationMinutes, tags: [{ tagId, value }], llmAnalysis }`

---

### Tool 5: `get_alert_history`
Fetch historical alerts with optional time range.

**Parameters:**
```json
{
  "machineId": { "type": "string" },
  "from": { "type": "string", "description": "ISO or relative like '24h', '7d', '30d'" },
  "to": { "type": "string" },
  "severity": { "type": "string", "enum": ["info", "warning", "critical", "all"], "default": "all" },
  "tagSlug": { "type": "string", "description": "Filter by specific tag that triggered alert (optional)" },
  "limit": { "type": "number", "default": 50 }
}
```

**Implementation:**
- Query `alertEvents` with time range on `startsAt`.
- If `tagSlug` provided, join `alertTags` and filter by tagId resolved from slug.
- Return summary: `{ total, bySeverity: { info, warning, critical }, byStatus: { open, acknowledged, resolved }, alerts: [...] }`

---

### Tool 6: `get_tag_definition`
Get threshold and configuration details for a tag.

**Parameters:**
```json
{
  "tag": { "type": "string", "description": "Tag name or slug — fuzzy matched" },
  "machineId": { "type": "string" }
}
```

**Implementation:**
- Fuzzy match: query `TagDefinition` where `name` contains the query string (case-insensitive) OR `slug` equals uppercased query.
- Return the full `TagDefinition` including: `slug, name, unit, dataType, min, max, warnHigh, warnLow, alarmHigh, alarmLow, deadband, sampleEveryMs, staleAfterMs`.
- If multiple matches, return top 3 with a note to be more specific.

---

### Tool 7: `get_production_summary`
Get current production metrics and efficiency stats.

**Parameters:**
```json
{
  "machineId": { "type": "string" }
}
```

**Implementation:**
- Fetch from `TagLatest`: `RUNNING_METER`, `TOTAL_METER`, `GSM_ENTRY`, `GRAM_ENTRY`, `LAMINATOR_MPM`, `MASTER_SPEED_PCT`, `UW_SET_TENSION`, `UW_PV_TENSION`
- Fetch from `TagLatest`: all ON/OFF and FAULT booleans
- Fetch count of open `alertEvents` for this machine from PostgreSQL
- Compute:
  - `lineEfficiency`: `(LAMINATOR_MPM / maxMPM) * 100` where maxMPM is from TagDefinition
  - `tensionDeviation`: `abs(UW_PV_TENSION - UW_SET_TENSION) / UW_SET_TENSION * 100`%
  - `machineStatus`: `"running"` if extruder+laminator+winder all ON, `"partial"` if some ON, `"stopped"` if all OFF
- Return structured summary with all values.

---

### Tool 8: `search_tags`
Search for tags by partial name, description, unit, or subsystem.

**Parameters:**
```json
{
  "query": { "type": "string", "description": "Search query — e.g. 'tension', 'amps', 'fault', 'winder', 'speed'" },
  "machineId": { "type": "string" }
}
```

**Implementation:**
- Query `TagDefinition` where `machineId = machineId` AND (`name ILIKE %query%` OR `slug ILIKE %query%` OR `unit ILIKE %query%` OR `department ILIKE %query%`).
- Return: array of `{ slug, name, unit, dataType, warnHigh, alarmHigh }` — max 10 results.
- This helps the AI discover tag names before querying them.

---

### Tool 9: `get_machine_status`
Get a quick health overview of the entire machine.

**Parameters:**
```json
{
  "machineId": { "type": "string" }
}
```

**Implementation:**
- Fetch all boolean safety/status tags: `EMG_STOP`, `ALARM_IND`, `EXTRUDER_ON_OFF`, `EXTRUDER_FAULT`, `LAMINATOR_ON_OFF`, `LAMINATOR_FAULT`, `WINDER_ON_OFF`, `WINDER_FAULT`, `SPLICE_ON_OFF`
- Fetch critical analog tags: `EXTRUDER_RPM`, `LAMINATOR_MPM`, `WINDER_TENSION_PCT`, `MASTER_SPEED_PCT`
- Fetch open alert count from PostgreSQL
- Return:
```json
  {
    "overallStatus": "healthy" | "warning" | "critical" | "stopped",
    "emergencyStop": false,
    "alarmActive": false,
    "subsystems": {
      "extruder": { "online": true, "fault": false, "rpm": 85.2 },
      "laminator": { "online": true, "fault": false, "mpm": 54.7 },
      "winder": { "online": true, "fault": false, "tensionPct": 50 }
    },
    "openAlerts": 2,
    "lastDataAt": "2025-01-01T00:00:00Z"
  }
```

---

### Tool 10: `acknowledge_alert`
Acknowledge an open alert event.

**Parameters:**
```json
{
  "alertEventId": { "type": "string" },
  "actor": { "type": "string", "description": "Name or ID of person acknowledging" },
  "note": { "type": "string", "description": "Optional note about the acknowledgement" }
}
```

**Implementation:**
- Insert into `acknowledgements` table with `alertEventId`, `actor`, `note`.
- Update `alertEvents.status` to `"acknowledged"` where `id = alertEventId`.
- Return: `{ success: true, alertEventId, acknowledgedAt, actor }`

---

### Tool 11: `get_chat_sessions`
List recent chat sessions for the machine.

**Parameters:**
```json
{
  "machineId": { "type": "string" },
  "limit": { "type": "number", "default": 10 }
}
```

**Implementation:**
- Query `chatSessions` where `machineId = machineId` ordered by `updatedAt DESC`, limit by `limit`.
- Return: `{ sessions: [{ id, title, createdAt, updatedAt, messageCount }] }`

---

## TAG NAME RESOLUTION (CRITICAL)

This is the most important helper function — ALL tools that accept a tag name must use it.

```typescript
async function resolveTagId(
  query: string,
  machineId: string
): Promise<TagDefinition | null> {
  // 1. Exact slug match (case-insensitive)
  const exactSlug = await prisma.tagDefinition.findFirst({
    where: {
      machineId,
      slug: { equals: query.toUpperCase() }
    }
  });
  if (exactSlug) return exactSlug;

  // 2. Fuzzy name match (contains)
  const nameMatch = await prisma.tagDefinition.findFirst({
    where: {
      machineId,
      name: { contains: query, mode: "insensitive" }
    }
  });
  if (nameMatch) return nameMatch;

  // 3. Partial slug match
  const slugMatch = await prisma.tagDefinition.findFirst({
    where: {
      machineId,
      slug: { contains: query.toUpperCase() }
    }
  });
  return slugMatch ?? null;
}
```

**Examples of queries that MUST resolve correctly:**
- `"extruder RPM"` → `EXTRUDER_RPM`
- `"laminator speed"` → `LAMINATOR_MPM`
- `"winder tension"` → `WINDER_TENSION_PCT`
- `"emergency stop"` → `EMG_STOP`
- `"amps"` → multiple results (return all)
- `"gsm"` → `GSM_ENTRY`
- `"rpm"` → `EXTRUDER_RPM`
- `"mpm"` → `LAMINATOR_MPM`

---

## GEMINI FUNCTION CALL LOOP

Gemini may request multiple sequential tool calls. Implement a proper agentic loop:

```typescript
async function runGeminiAgent(
  userMessage: string,
  history: ChatMessage[],
  machineId: string
): Promise<{ reply: string; toolsUsed: string[] }> {
  
  const toolsUsed: string[] = [];
  
  // Build Gemini history from DB messages
  const geminiHistory = history.slice(-50).map(msg => ({
    role: msg.role === "user" ? "user" : "model",
    parts: [{ text: msg.content }]
  }));

  const chat = geminiModel.startChat({
    history: geminiHistory,
    tools: [{ functionDeclarations: ALL_TOOL_DECLARATIONS }],
    systemInstruction: SYSTEM_PROMPT
  });

  let response = await chat.sendMessage(userMessage);
  
  // Agentic loop — keep executing tool calls until Gemini returns text
  while (true) {
    const candidate = response.candidates?.[0];
    const parts = candidate?.content?.parts ?? [];
    
    // Check for function calls
    const functionCalls = parts.filter(p => p.functionCall);
    
    if (functionCalls.length === 0) {
      // No more tool calls — extract final text reply
      const textPart = parts.find(p => p.text);
      return { reply: textPart?.text ?? "No response", toolsUsed };
    }
    
    // Execute all function calls in parallel
    const toolResults = await Promise.all(
      functionCalls.map(async (part) => {
        const { name, args } = part.functionCall!;
        toolsUsed.push(name);
        
        try {
          const result = await executeTool(name, args, machineId);
          return {
            functionResponse: {
              name,
              response: { result }
            }
          };
        } catch (err: any) {
          return {
            functionResponse: {
              name,
              response: { error: err.message }
            }
          };
        }
      })
    );
    
    // Send tool results back to Gemini
    response = await chat.sendMessage(toolResults);
  }
}
```

---

## FASTIFY ROUTE STRUCTURE
POST /chat
Body: { sessionId?, machineId?, message }

Validate body
Resolve or create chatSession (PostgreSQL)
Load last 50 chatMessages for session
Run Gemini agent loop with tools
Save user + assistant messages to chatMessages
Update chatSession.updatedAt
Return { sessionId, messageId, reply, toolsUsed }

GET /chat/sessions?machineId=lamination-01
Returns list of chat sessions
GET /chat/sessions/:sessionId/messages?limit=50&before=<messageId>
Returns paginated message history (cursor-based, newest first)
DELETE /chat/sessions/:sessionId
Soft delete (set deletedAt) or hard delete

---

## ERROR HANDLING RULES

1. All DB calls must be wrapped in try/catch. Return `500` with structured error.
2. If Gemini API fails (rate limit, timeout), return `503` with `retryAfter: 30`.
3. If `sessionId` is provided but not found in DB, return `404`.
4. If tag resolution fails (no match), tool returns `{ error: "Tag not found: <query>. Use search_tags to find available tags." }` — do NOT throw.
5. All Fastify routes must have `schema` defined (JSON Schema for request/response validation).
6. Log every tool call with `fastify.log.info({ tool: name, args, machineId, sessionId })`.

---

## ENVIRONMENT VARIABLES
DATABASE_URL=postgresql://...   # PostgreSQL for Drizzle
MONGODB_URL=mongodb://...       # MongoDB for Prisma
GEMINI_API_KEY=...              # Google AI Studio key
PORT=7000
NODE_ENV=production

---

## CODE QUALITY REQUIREMENTS

1. **TypeScript strict mode** — no `any` except where interfacing with external APIs.
2. **Zod validation** on all Fastify route bodies and params.
3. **Connection pooling** — single Drizzle and Prisma client instance (singleton pattern).
4. **Graceful shutdown** — close DB connections on `SIGTERM`.
5. **Structured logging** — use `fastify.log` (pino) with `{ sessionId, machineId, tool }` context.
6. **No N+1 queries** — batch tag lookups where possible.
7. All IDs generated with `nanoid()` or `cuid2()`.
8. All timestamps stored as UTC.
9. Prisma queries use `select` to only fetch needed fields.
10. Drizzle queries use `where` with proper indexes (see schema).

---

## WHAT TO BUILD

When I say "build the chat route", implement:

1. `src/db/postgres.ts` — Drizzle client singleton
2. `src/db/mongo.ts` — Prisma client singleton
3. `src/db/migrations/chat.ts` — Drizzle migration for `chatSessions` + `chatMessages` tables
4. `src/ai/tools.ts` — All 11 tool implementations
5. `src/ai/agent.ts` — Gemini client, tool declarations, agentic loop (`runGeminiAgent`)
6. `src/routes/chat.ts` — Fastify route plugin with all 4 endpoints
7. `src/routes/chat.schema.ts` — Zod schemas + Fastify JSON Schema for all routes

Register the chat plugin in the main Fastify app at prefix `/chat`.

Always write the full file — no placeholders, no `// TODO`, no `...` ellipsis. Production code only.