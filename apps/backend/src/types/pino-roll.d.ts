declare module "pino-roll" {
  import type { Writable } from "node:stream";

  export default function pinoRoll(options: {
    file: string;
    frequency?: string;
    limit?: { count?: number };
    mkdir?: boolean;
  }): Promise<Writable>;
}
