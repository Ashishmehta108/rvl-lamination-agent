import { z } from "zod";

export const getMachineStatusSchema = z.object({
  machineId: z.string().optional()
});

export type GetMachineStatusArgs = z.infer<typeof getMachineStatusSchema>;
