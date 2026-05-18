import { GoogleGenerativeAI } from "@google/generative-ai";
import { config } from "../config.js";
import { bedrockChatOnce, bedrockEmbedText } from "./bedrock.js";

type GeminiMessage = {
  role: "system" | "user" | "assistant";
  content: string;
};

function client(): GoogleGenerativeAI {
  if (!config.geminiApiKey) {
    throw new Error("GEMINI_API_KEY is required");
  }
  return new GoogleGenerativeAI(config.geminiApiKey);
}

function timeoutAfter(ms: number): Promise<never> {
  return new Promise((_, reject) => {
    setTimeout(() => reject(new Error(`gemini_timeout_${ms}ms`)), ms);
  });
}

export async function geminiChatOnce(args: {
  messages: GeminiMessage[];
  model?: string;
  temperature?: number;
  timeoutMs?: number;
}): Promise<string> {
  const systemPrompt = args.messages
    .filter((message) => message.role === "system")
    .map((message) => message.content)
    .join("\n\n");
  const userText = args.messages
    .filter((message) => message.role !== "system")
    .map((message) => `${message.role.toUpperCase()}:\n${message.content}`)
    .join("\n\n");

  const model = client().getGenerativeModel({
    model: args.model ?? config.geminiModel,
    systemInstruction: systemPrompt || undefined,
    generationConfig: {
      temperature: args.temperature ?? 0
    }
  });

  const responsePromise = model.generateContent(userText);
  const response = await Promise.race([responsePromise, timeoutAfter(args.timeoutMs ?? config.llmTimeoutMs)]);
  return response.response.text();
}

export async function providerChatOnce(args: {
  messages: GeminiMessage[];
  model?: string;
  temperature?: number;
  timeoutMs?: number;
}): Promise<string> {
  if (config.aiProvider === "bedrock") {
    return bedrockChatOnce({
      messages: args.messages,
      model: args.model ?? config.bedrockReportModelId,
      temperature: args.temperature,
      timeoutMs: args.timeoutMs
    });
  }
  return geminiChatOnce(args);
}

export async function embedText(text: string): Promise<number[]> {
  if (config.embeddingProvider === "bedrock") {
    return bedrockEmbedText(text);
  }
  const model = client().getGenerativeModel({ model: config.geminiEmbeddingModel });
  const result = await model.embedContent(text);
  return result.embedding.values;
}
