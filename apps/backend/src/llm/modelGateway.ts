import { Ollama } from "ollama";
import { config } from "../config.js";

export type LlmMessage = { role: "system" | "user" | "assistant"; content: string };

export interface LlmCallOptions {
  numCtx?: number;
  temperature?: number;
  topP?: number;
  repeatPenalty?: number;
  timeoutMs?: number;
}

/** Model tier names — maps to the configured model per role. */
export type ModelTier = "chat" | "planner" | "report" | "embed" | "fallback";

/**
 * Provider interface — all LLM providers implement this.
 * Currently only OllamaProvider exists; interface is ready for cloud providers.
 */
export interface LlmProvider {
  readonly name: string;
  chat(messages: LlmMessage[], options?: LlmCallOptions): Promise<string>;
  embed(text: string): Promise<number[]>;
  health(): Promise<boolean>;
  listModels(): Promise<string[]>;
}

/**
 * Model gateway — routes calls to the correct model tier,
 * adds circuit breaking, and provides a single interface for all LLM access.
 */
export interface ModelGateway {
  /** Call the model for the given tier with circuit-breaker protection. */
  chatWithTier(tier: ModelTier, messages: LlmMessage[], options?: LlmCallOptions): Promise<string>;
  embed(text: string): Promise<number[]>;
  healthCheck(): Promise<{ [key: string]: boolean }>;
}

// ─── Timeout helper ───────────────────────────────────────────────────────────

function withTimeout<T>(p: Promise<T>, timeoutMs: number, name: string): Promise<T> {
  if (!timeoutMs || timeoutMs <= 0) return p;
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(
      () => reject(new Error(`${name}_timeout_after_${timeoutMs}ms`)),
      timeoutMs
    );
    p.then(
      (v) => { clearTimeout(t); resolve(v); },
      (err) => { clearTimeout(t); reject(err); }
    );
  });
}

// ─── Ollama Provider ──────────────────────────────────────────────────────────

class OllamaProvider implements LlmProvider {
  readonly name = "ollama";
  private client: Ollama;

  constructor() {
    this.client = new Ollama({ host: config.ollamaBaseUrl });
  }

  async chat(messages: LlmMessage[], options?: LlmCallOptions): Promise<string> {
    const out = await withTimeout(
      this.client.chat({
        model: options?.numCtx ? config.ollamaModel : config.ollamaModel,
        messages,
        stream: false,
        options: {
          temperature: options?.temperature ?? config.ollamaTemperature,
          top_p: options?.topP ?? config.ollamaTopP,
          repeat_penalty: options?.repeatPenalty ?? config.ollamaRepeatPenalty,
          num_ctx: options?.numCtx ?? config.ollamaNumCtx,
        },
        keep_alive: config.ollamaKeepAlive,
      }),
      options?.timeoutMs ?? config.llmTimeoutMs,
      "ollama_chat"
    );
    return out.message.content;
  }

  async embed(text: string): Promise<number[]> {
    const res = await withTimeout(
      this.client.embeddings({ model: config.embedModel, prompt: text }),
      config.llmTimeoutMs,
      "ollama_embed"
    );
    return res.embedding;
  }

  async health(): Promise<boolean> {
    try {
      const controller = new AbortController();
      const t = setTimeout(() => controller.abort(), 2000);
      const res = await fetch(`${config.ollamaBaseUrl}/api/tags`, { signal: controller.signal });
      clearTimeout(t);
      return res.ok;
    } catch {
      return false;
    }
  }

  async listModels(): Promise<string[]> {
    try {
      const controller = new AbortController();
      const t = setTimeout(() => controller.abort(), 2000);
      const res = await fetch(`${config.ollamaBaseUrl}/api/tags`, { signal: controller.signal });
      clearTimeout(t);
      if (!res.ok) return [];
      const body = (await res.json()) as { models?: { name?: string }[] };
      return (body.models ?? []).map((m) => m.name).filter((n): n is string => Boolean(n));
    } catch {
      return [];
    }
  }
}

// ─── Model tier → model name resolution ──────────────────────────────────────

function resolveModel(tier: ModelTier): string {
  switch (tier) {
    case "report": return config.ollamaReportModel;
    case "embed":  return config.embedModel;
    case "chat":
    case "planner":
    case "fallback":
    default:       return config.ollamaModel;
  }
}

function resolveNumCtx(tier: ModelTier): number {
  return tier === "report" ? config.ollamaReportNumCtx : config.ollamaNumCtx;
}

// ─── Circuit Breaker ──────────────────────────────────────────────────────────

interface CircuitState {
  failures: number;
  degradedUntil: number;
}

const CIRCUIT_THRESHOLD = config.nodeEnv === "test" ? 999 : 3;
const CIRCUIT_RECOVERY_MS = 60_000;

const circuit: CircuitState = { failures: 0, degradedUntil: 0 };

function isCircuitOpen(): boolean {
  return circuit.failures >= CIRCUIT_THRESHOLD && Date.now() < circuit.degradedUntil;
}

function recordSuccess(): void {
  circuit.failures = 0;
  circuit.degradedUntil = 0;
}

function recordFailure(): void {
  circuit.failures += 1;
  if (circuit.failures >= CIRCUIT_THRESHOLD) {
    circuit.degradedUntil = Date.now() + CIRCUIT_RECOVERY_MS;
  }
}

// ─── Gateway Implementation ───────────────────────────────────────────────────

class ModelGatewayImpl implements ModelGateway {
  constructor(private provider: LlmProvider) {}

  async chatWithTier(
    tier: ModelTier,
    messages: LlmMessage[],
    options?: LlmCallOptions
  ): Promise<string> {
    if (isCircuitOpen()) {
      throw new Error(`model_gateway_circuit_open: provider=${this.provider.name} tier=${tier}`);
    }

    const model = resolveModel(tier);
    const numCtx = resolveNumCtx(tier);

    try {
      const result = await this.provider.chat(messages, { ...options, numCtx });
      recordSuccess();
      return result;
    } catch (err) {
      recordFailure();
      throw err;
    }
  }

  async embed(text: string): Promise<number[]> {
    return this.provider.embed(text);
  }

  async healthCheck(): Promise<{ [key: string]: boolean }> {
    const ok = await this.provider.health();
    return { [this.provider.name]: ok };
  }
}

// ─── Singleton ────────────────────────────────────────────────────────────────

let _gateway: ModelGateway | null = null;

export function getModelGateway(): ModelGateway {
  if (!_gateway) {
    _gateway = new ModelGatewayImpl(new OllamaProvider());
  }
  return _gateway;
}

/** For testing — inject a mock gateway. */
export function setModelGateway(gateway: ModelGateway): void {
  _gateway = gateway;
}
