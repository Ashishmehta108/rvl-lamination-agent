export const Jobs = {
  tagUpdated: "tag.updated",
  alertDeliver: "alert.deliver",
  reportRun: "report.run"
} as const;

export type JobName = (typeof Jobs)[keyof typeof Jobs];

