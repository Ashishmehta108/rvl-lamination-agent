CREATE TYPE "public"."alert_severity" AS ENUM('info', 'warning', 'critical');--> statement-breakpoint
CREATE TYPE "public"."alert_status" AS ENUM('open', 'acknowledged', 'resolved');--> statement-breakpoint
CREATE TYPE "public"."delivery_channel" AS ENUM('email', 'webhook');--> statement-breakpoint
CREATE TYPE "public"."delivery_status" AS ENUM('queued', 'sending', 'sent', 'failed');--> statement-breakpoint
CREATE TYPE "public"."report_format" AS ENUM('html', 'json');--> statement-breakpoint
CREATE TYPE "public"."run_status" AS ENUM('queued', 'running', 'succeeded', 'failed');--> statement-breakpoint
CREATE TABLE "acknowledgements" (
	"id" text PRIMARY KEY NOT NULL,
	"alert_event_id" text NOT NULL,
	"actor" text NOT NULL,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "alert_deliveries" (
	"id" text PRIMARY KEY NOT NULL,
	"alert_event_id" text NOT NULL,
	"channel" "delivery_channel" NOT NULL,
	"destination" text NOT NULL,
	"status" "delivery_status" DEFAULT 'queued' NOT NULL,
	"attempt" integer DEFAULT 0 NOT NULL,
	"idempotency_key" text NOT NULL,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"sent_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "alert_events" (
	"id" text PRIMARY KEY NOT NULL,
	"machine_id" text NOT NULL,
	"rule_id" text,
	"severity" "alert_severity" NOT NULL,
	"status" "alert_status" DEFAULT 'open' NOT NULL,
	"title" text NOT NULL,
	"description" text,
	"dedupe_key" text,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"llm_analysis" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"starts_at" timestamp with time zone NOT NULL,
	"ends_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "alert_rules" (
	"id" text PRIMARY KEY NOT NULL,
	"machine_id" text NOT NULL,
	"name" text NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"severity_default" "alert_severity" DEFAULT 'warning' NOT NULL,
	"condition" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "alert_tags" (
	"alert_event_id" text NOT NULL,
	"tag_id" text NOT NULL,
	"tag_snapshot" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "alert_tags_alert_event_id_tag_id_pk" PRIMARY KEY("alert_event_id","tag_id")
);
--> statement-breakpoint
CREATE TABLE "report_artifacts" (
	"id" text PRIMARY KEY NOT NULL,
	"run_id" text NOT NULL,
	"type" "report_format" NOT NULL,
	"uri" text NOT NULL,
	"checksum" text,
	"bytes" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "report_runs" (
	"id" text PRIMARY KEY NOT NULL,
	"schedule_id" text,
	"template_id" text NOT NULL,
	"machine_id" text NOT NULL,
	"status" "run_status" DEFAULT 'queued' NOT NULL,
	"window_start" timestamp with time zone NOT NULL,
	"window_end" timestamp with time zone NOT NULL,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"error" text,
	"metrics" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "report_schedules" (
	"id" text PRIMARY KEY NOT NULL,
	"template_id" text NOT NULL,
	"machine_id" text NOT NULL,
	"timezone" text DEFAULT 'UTC' NOT NULL,
	"cron" text NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"delivery_targets" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_run_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "report_templates" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"format" "report_format" DEFAULT 'html' NOT NULL,
	"definition" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "acknowledgements" ADD CONSTRAINT "acknowledgements_alert_event_id_alert_events_id_fk" FOREIGN KEY ("alert_event_id") REFERENCES "public"."alert_events"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "alert_deliveries" ADD CONSTRAINT "alert_deliveries_alert_event_id_alert_events_id_fk" FOREIGN KEY ("alert_event_id") REFERENCES "public"."alert_events"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "alert_tags" ADD CONSTRAINT "alert_tags_alert_event_id_alert_events_id_fk" FOREIGN KEY ("alert_event_id") REFERENCES "public"."alert_events"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "report_artifacts" ADD CONSTRAINT "report_artifacts_run_id_report_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."report_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "report_runs" ADD CONSTRAINT "report_runs_schedule_id_report_schedules_id_fk" FOREIGN KEY ("schedule_id") REFERENCES "public"."report_schedules"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "report_runs" ADD CONSTRAINT "report_runs_template_id_report_templates_id_fk" FOREIGN KEY ("template_id") REFERENCES "public"."report_templates"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "report_schedules" ADD CONSTRAINT "report_schedules_template_id_report_templates_id_fk" FOREIGN KEY ("template_id") REFERENCES "public"."report_templates"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ack_alert_idx" ON "acknowledgements" USING btree ("alert_event_id");--> statement-breakpoint
CREATE INDEX "alert_deliveries_alert_idx" ON "alert_deliveries" USING btree ("alert_event_id");--> statement-breakpoint
CREATE UNIQUE INDEX "alert_deliveries_idempotency_idx" ON "alert_deliveries" USING btree ("idempotency_key");--> statement-breakpoint
CREATE INDEX "alert_events_machine_status_starts_idx" ON "alert_events" USING btree ("machine_id","status","starts_at");--> statement-breakpoint
CREATE UNIQUE INDEX "alert_events_machine_dedupe_idx" ON "alert_events" USING btree ("machine_id","dedupe_key");--> statement-breakpoint
CREATE INDEX "alert_rules_machine_idx" ON "alert_rules" USING btree ("machine_id");--> statement-breakpoint
CREATE INDEX "alert_tags_tag_idx" ON "alert_tags" USING btree ("tag_id");--> statement-breakpoint
CREATE INDEX "report_artifacts_run_idx" ON "report_artifacts" USING btree ("run_id");--> statement-breakpoint
CREATE INDEX "report_runs_machine_window_idx" ON "report_runs" USING btree ("machine_id","window_start","window_end");--> statement-breakpoint
CREATE INDEX "report_schedules_machine_idx" ON "report_schedules" USING btree ("machine_id");--> statement-breakpoint
CREATE INDEX "report_schedules_enabled_idx" ON "report_schedules" USING btree ("enabled");