import { config } from "../config.js";

export const MAX_TOOL_CALLS = 12;   // hard cap per request
export const MAX_RETRIES = 2;       // per tool on transient error
export const TOOL_TIMEOUT_MS = 8000; // per-tool execution timeout
export const LLM_TIMEOUT_MS = config.llmTimeoutMs ?? 25000;
