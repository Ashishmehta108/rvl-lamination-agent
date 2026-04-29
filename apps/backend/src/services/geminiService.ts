import { GoogleGenerativeAI } from "@google/generative-ai";
import { config } from "../config.js";

const genAI = new GoogleGenerativeAI(config.googleApiKey);
const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash-lite" });

export interface LLMContextData {
  alerts: string;
  tags: string;
  production: string;
}

/**
 * buildLLMContext(data)
 *
 * Rules:
 * - max 5 alerts
 * - only key readings (max 5)
 * - summarized production
 * - NO IDs, NO raw DB fields
 */
export function buildLLMContext(data: {
  alertsRaw: string;
  tagsRaw: string;
  productionRaw: string;
}): string {

  // ALERTS (top 5 only)
  const alerts = data.alertsRaw
    .split("\n")
    .filter(l => l.includes("ALERT"))
    .slice(0, 5)
    .map(l => {
      const severity = l.match(/\[(.*?)\]/)?.[1] || "info";
      const title = l.match(/title:\s*"([^"]+)"/)?.[1] || "unknown";
      const status = l.match(/status:\s*(\w+)/)?.[1] || "unknown";

      return { severity, title, status };
    });

  // TAGS (ONLY IMPORTANT ONES)
  const importantTags = ["RPM", "TENSION", "TEMP", "CURRENT"];

  const tags = data.tagsRaw
    .split("\n")
    .filter(l => importantTags.some(t => l.toUpperCase().includes(t)))
    .slice(0, 5)
    .map(l => {
      const parts = l.replace("* ", "").split(":");
      return {
        label: parts[0]?.trim(),
        value: parts[1]?.split("[")[0]?.trim()
      };
    });

  // PRODUCTION (simple)
  const production = data.productionRaw
    .split("\n")
    .slice(0, 2);

  return JSON.stringify({
    alerts,
    key_readings: tags,
    production_summary: production
  });
}

/**
 * System Prompt:
 * 2–3 sentences max
 * no hallucination
 * no reasoning
 * no cause inference
 * only use provided context
 * if missing data → say "I don’t have that data"
 */
const SYSTEM_PROMPT = `
You are Ravi, an industrial machine assistant.

RULES:
- Answer in EXACTLY 2–3 sentences.
- Use ONLY the provided JSON.
- Do NOT guess or infer causes.
- Mention critical alerts first.
- If no alerts, say system is stable.
- If data missing, say "I don’t have that data".
- Do NOT explain reasoning.
`;
export async function callGemini(query: string, context: string): Promise<string> {
  if (!config.googleApiKey) {
    return "Gemini API key is not configured.";
  }

  const prompt = `
${SYSTEM_PROMPT}

DATA (JSON):
${context}

USER:
${query}

ANSWER:
`;

  try {
    const result = await model.generateContent(prompt);
    const response = await result.response;
    return response.text().trim();
  } catch (error) {
    console.error("Gemini API Error:", error);
    return "Error communicating with Gemini.";
  }
}
