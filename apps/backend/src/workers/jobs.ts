export const Jobs = {
  tagUpdated: "tag.updated",
  alertDeliver: "alert.deliver",
  reportRun: "report.run",
  reportEmail: "report.email",
  mlRetrain: "ml.retrain",
  mlCollect: "ml.collect",
} as const;

export type JobName = (typeof Jobs)[keyof typeof Jobs];

