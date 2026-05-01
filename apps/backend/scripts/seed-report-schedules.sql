-- Example report schedules for reportScheduler (node-cron polls every minute).
-- Replace YOUR_TEMPLATE_ID with an id from: SELECT id, name FROM report_templates LIMIT 5;
-- Or trigger one report from the UI first so a template row exists.

INSERT INTO report_schedules (id, template_id, machine_id, timezone, cron, enabled, delivery_targets, created_at)
VALUES
  ('sched_rvl_daily', 'YOUR_TEMPLATE_ID', 'lamination-01', 'UTC', '0 6 * * *', true, '{}', now()),
  ('sched_rvl_monthly', 'YOUR_TEMPLATE_ID', 'lamination-01', 'UTC', '0 7 1 * *', true, '{}', now())
ON CONFLICT (id) DO UPDATE SET
  cron = EXCLUDED.cron,
  enabled = EXCLUDED.enabled,
  template_id = EXCLUDED.template_id,
  machine_id = EXCLUDED.machine_id;
