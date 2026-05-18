import {
  BedrockRuntimeClient,
  ConverseCommand,
  InvokeModelCommand,
  type ContentBlock,
  type Message,
  type Tool,
  type ToolChoice,
  type ToolUseBlock
} from "@aws-sdk/client-bedrock-runtime";
import type { FunctionDeclaration } from "@google/generative-ai";
import { config } from "../config.js";

export type BedrockChatMessage = {
  role: "system" | "user" | "assistant";
  content: string;
};

let clientSingleton: BedrockRuntimeClient | null = null;

function client(): BedrockRuntimeClient {
  if (!clientSingleton) {
    clientSingleton = new BedrockRuntimeClient({ region: config.bedrockRegion });
  }
  return clientSingleton;
}

function timeoutAfter(ms: number): Promise<never> {
  return new Promise((_, reject) => {
    setTimeout(() => reject(new Error(`bedrock_timeout_${ms}ms`)), ms);
  });
}

function normalizeSchema(input: unknown): Record<string, unknown> {
  if (!input || typeof input !== "object") return {};
  const raw = input as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (key === "format") continue;
    if (key === "type" && typeof value === "string") {
      out[key] = value.toLowerCase();
      continue;
    }
    if (key === "properties" && value && typeof value === "object") {
      out[key] = Object.fromEntries(
        Object.entries(value as Record<string, unknown>).map(([propKey, propValue]) => [propKey, normalizeSchema(propValue)])
      );
      continue;
    }
    if (key === "items") {
      out[key] = normalizeSchema(value);
      continue;
    }
    out[key] = value;
  }
  return out;
}

export function bedrockToolsFromDeclarations(declarations: FunctionDeclaration[]): Tool[] {
  return declarations.map((declaration) => ({
    toolSpec: {
      name: declaration.name,
      description: declaration.description,
      inputSchema: {
        json: normalizeSchema(declaration.parameters)
      }
    }
  }) as Tool);
}

export function toBedrockMessages(history: BedrockChatMessage[], userMessage: string): Message[] {
  const mapped: Message[] = history
    .filter((message) => message.role !== "system" && message.content.trim() !== "")
    .slice(-50)
    .map((message) => ({
      role: message.role === "assistant" ? "assistant" : "user",
      content: [{ text: message.content }]
    }));

  while (mapped.length > 0 && mapped[0]?.role !== "user") mapped.shift();

  const normalized: Message[] = [];
  for (const item of mapped) {
    const previous = normalized[normalized.length - 1];
    if (previous && previous.role === item.role) {
      if (previous.content) previous.content.push(...(item.content ?? []));
      continue;
    }
    normalized.push(item);
  }
  if (normalized[normalized.length - 1]?.role === "user") normalized.pop();

  normalized.push({ role: "user", content: [{ text: userMessage }] });
  return normalized;
}

export function extractText(content: ContentBlock[] | undefined): string {
  return (content ?? [])
    .map((block) => ("text" in block && typeof block.text === "string" ? block.text : ""))
    .join("")
    .trim();
}

export function extractToolUses(content: ContentBlock[] | undefined): ToolUseBlock[] {
  return (content ?? [])
    .filter((block): block is ContentBlock & { toolUse: ToolUseBlock } => "toolUse" in block && Boolean(block.toolUse))
    .map((block) => block.toolUse);
}

export async function bedrockConverse(args: {
  systemPrompt: string;
  messages: Message[];
  tools?: Tool[];
  toolChoice?: ToolChoice;
  modelId?: string;
  temperature?: number;
  timeoutMs?: number;
}) {
  const command = new ConverseCommand({
    modelId: args.modelId ?? config.bedrockModelId,
    system: args.systemPrompt ? [{ text: args.systemPrompt }] : undefined,
    messages: args.messages,
    toolConfig: args.tools?.length
      ? { tools: args.tools, toolChoice: args.toolChoice }
      : undefined,
    inferenceConfig: {
      temperature: args.temperature ?? 0.2,
      topP: 0.85,
      maxTokens: config.bedrockMaxTokens
    }
  });
  return Promise.race([client().send(command), timeoutAfter(args.timeoutMs ?? config.llmTimeoutMs)]);
}

export async function bedrockChatOnce(args: {
  messages: BedrockChatMessage[];
  model?: string;
  temperature?: number;
  timeoutMs?: number;
}): Promise<string> {
  const systemPrompt = args.messages
    .filter((message) => message.role === "system")
    .map((message) => message.content)
    .join("\n\n");
  const nonSystem = args.messages.filter((message) => message.role !== "system");
  const userMessage = nonSystem.at(-1)?.content ?? "";
  const messages = toBedrockMessages(nonSystem.slice(0, -1), userMessage);
  const response = await bedrockConverse({
    systemPrompt,
    messages,
    modelId: args.model ?? config.bedrockReportModelId,
    temperature: args.temperature ?? 0,
    timeoutMs: args.timeoutMs
  });
  return extractText(response.output?.message?.content);
}

export async function bedrockEmbedText(text: string): Promise<number[]> {
  const response = await client().send(
    new InvokeModelCommand({
      modelId: config.bedrockEmbeddingModelId,
      contentType: "application/json",
      accept: "application/json",
      body: JSON.stringify({ inputText: text })
    })
  );
  const body = JSON.parse(Buffer.from(response.body).toString("utf8")) as { embedding?: number[] };
  if (!Array.isArray(body.embedding)) throw new Error("bedrock_embedding_missing");
  return body.embedding;
}
