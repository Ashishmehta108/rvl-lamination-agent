import {
  boolean,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex
} from "drizzle-orm/pg-core";
import { relations } from "drizzle-orm";

export const alertSeverity = pgEnum("alert_severity", ["info", "warning", "critical"]);
export const alertStatus = pgEnum("alert_status", ["open", "acknowledged", "resolved"]);
export const deliveryChannel = pgEnum("delivery_channel", ["email", "webhook"]);
export const deliveryStatus = pgEnum("delivery_status", ["queued", "sending", "sent", "failed"]);
export const reportFormat = pgEnum("report_format", ["html", "json"]);
export const runStatus = pgEnum("run_status", ["queued", "running", "succeeded", "failed"]);

export const alertRules = pgTable(
  "alert_rules",
  {
    id: text("id").primaryKey(),
    machineId: text("machine_id").notNull(),
    name: text("name").notNull(),
    enabled: boolean("enabled").notNull().default(true),
    severityDefault: alertSeverity("severity_default").notNull().default("warning"),
    condition: jsonb("condition").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow()
  },
  (t) => ({
    machineIdx: index("alert_rules_machine_idx").on(t.machineId)
  })
);

export const alertEvents = pgTable(
  "alert_events",
  {
    id: text("id").primaryKey(),
    machineId: text("machine_id").notNull(),
    ruleId: text("rule_id"),
    severity: alertSeverity("severity").notNull(),
    status: alertStatus("status").notNull().default("open"),
    title: text("title").notNull(),
    description: text("description"),
    dedupeKey: text("dedupe_key"),
    payload: jsonb("payload").notNull().default({}),
    llmAnalysis: jsonb("llm_analysis").notNull().default({}),
    startsAt: timestamp("starts_at", { withTimezone: true }).notNull(),
    endsAt: timestamp("ends_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow()
  },
  (t) => ({
    machineStatusStartsIdx: index("alert_events_machine_status_starts_idx").on(
      t.machineId,
      t.status,
      t.startsAt
    ),
    dedupeIdx: uniqueIndex("alert_events_machine_dedupe_idx").on(t.machineId, t.dedupeKey)
  })
);

export const alertTags = pgTable(
  "alert_tags",
  {
    alertEventId: text("alert_event_id")
      .notNull()
      .references(() => alertEvents.id, { onDelete: "cascade" }),
    tagId: text("tag_id").notNull(),
    tagSnapshot: jsonb("tag_snapshot").notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow()
  },
  (t) => ({
    pk: primaryKey({ columns: [t.alertEventId, t.tagId] }),
    tagIdx: index("alert_tags_tag_idx").on(t.tagId)
  })
);

export const alertDeliveries = pgTable(
  "alert_deliveries",
  {
    id: text("id").primaryKey(),
    alertEventId: text("alert_event_id")
      .notNull()
      .references(() => alertEvents.id, { onDelete: "cascade" }),
    channel: deliveryChannel("channel").notNull(),
    destination: text("destination").notNull(),
    status: deliveryStatus("status").notNull().default("queued"),
    attempt: integer("attempt").notNull().default(0),
    idempotencyKey: text("idempotency_key").notNull(),
    lastError: text("last_error"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    sentAt: timestamp("sent_at", { withTimezone: true })
  },
  (t) => ({
    alertIdx: index("alert_deliveries_alert_idx").on(t.alertEventId),
    idempotencyIdx: uniqueIndex("alert_deliveries_idempotency_idx").on(t.idempotencyKey)
  })
);

export const acknowledgements = pgTable(
  "acknowledgements",
  {
    id: text("id").primaryKey(),
    alertEventId: text("alert_event_id")
      .notNull()
      .references(() => alertEvents.id, { onDelete: "cascade" }),
    actor: text("actor").notNull(),
    note: text("note"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow()
  },
  (t) => ({
    alertIdx: index("ack_alert_idx").on(t.alertEventId)
  })
);

export const reportTemplates = pgTable("report_templates", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  description: text("description"),
  format: reportFormat("format").notNull().default("html"),
  definition: jsonb("definition").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow()
});

export const reportSchedules = pgTable(
  "report_schedules",
  {
    id: text("id").primaryKey(),
    templateId: text("template_id")
      .notNull()
      .references(() => reportTemplates.id, { onDelete: "restrict" }),
    machineId: text("machine_id").notNull(),
    timezone: text("timezone").notNull().default("UTC"),
    cron: text("cron").notNull(),
    enabled: boolean("enabled").notNull().default(true),
    deliveryTargets: jsonb("delivery_targets").notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    lastRunAt: timestamp("last_run_at", { withTimezone: true })
  },
  (t) => ({
    machineIdx: index("report_schedules_machine_idx").on(t.machineId),
    enabledIdx: index("report_schedules_enabled_idx").on(t.enabled)
  })
);

export const reportRuns = pgTable(
  "report_runs",
  {
    id: text("id").primaryKey(),
    scheduleId: text("schedule_id").references(() => reportSchedules.id, { onDelete: "set null" }),
    templateId: text("template_id")
      .notNull()
      .references(() => reportTemplates.id, { onDelete: "restrict" }),
    machineId: text("machine_id").notNull(),
    status: runStatus("status").notNull().default("queued"),
    windowStart: timestamp("window_start", { withTimezone: true }).notNull(),
    windowEnd: timestamp("window_end", { withTimezone: true }).notNull(),
    startedAt: timestamp("started_at", { withTimezone: true }),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    error: text("error"),
    metrics: jsonb("metrics").notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow()
  },
  (t) => ({
    machineWindowIdx: index("report_runs_machine_window_idx").on(t.machineId, t.windowStart, t.windowEnd)
  })
);

export const reportArtifacts = pgTable(
  "report_artifacts",
  {
    id: text("id").primaryKey(),
    runId: text("run_id")
      .notNull()
      .references(() => reportRuns.id, { onDelete: "cascade" }),
    type: reportFormat("type").notNull(),
    uri: text("uri").notNull(),
    checksum: text("checksum"),
    bytes: integer("bytes").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow()
  },
  (t) => ({
    runIdx: index("report_artifacts_run_idx").on(t.runId)
  })
);

export const alertRulesRelations = relations(alertRules, ({ many }) => ({
  events: many(alertEvents)
}));

export const alertEventsRelations = relations(alertEvents, ({ one, many }) => ({
  rule: one(alertRules, { fields: [alertEvents.ruleId], references: [alertRules.id] }),
  tags: many(alertTags),
  deliveries: many(alertDeliveries),
  acknowledgements: many(acknowledgements)
}));

export const alertTagsRelations = relations(alertTags, ({ one }) => ({
  event: one(alertEvents, { fields: [alertTags.alertEventId], references: [alertEvents.id] })
}));

export const alertDeliveriesRelations = relations(alertDeliveries, ({ one }) => ({
  event: one(alertEvents, { fields: [alertDeliveries.alertEventId], references: [alertEvents.id] })
}));

export const ackRelations = relations(acknowledgements, ({ one }) => ({
  event: one(alertEvents, { fields: [acknowledgements.alertEventId], references: [alertEvents.id] })
}));

export const templateRelations = relations(reportTemplates, ({ many }) => ({
  schedules: many(reportSchedules),
  runs: many(reportRuns)
}));

export const scheduleRelations = relations(reportSchedules, ({ one, many }) => ({
  template: one(reportTemplates, { fields: [reportSchedules.templateId], references: [reportTemplates.id] }),
  runs: many(reportRuns)
}));

export const runRelations = relations(reportRuns, ({ one, many }) => ({
  template: one(reportTemplates, { fields: [reportRuns.templateId], references: [reportTemplates.id] }),
  schedule: one(reportSchedules, { fields: [reportRuns.scheduleId], references: [reportSchedules.id] }),
  artifacts: many(reportArtifacts)
}));

export const artifactRelations = relations(reportArtifacts, ({ one }) => ({
  run: one(reportRuns, { fields: [reportArtifacts.runId], references: [reportRuns.id] })
}));

