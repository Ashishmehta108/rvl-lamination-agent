import { ChatOllama } from "@langchain/ollama";
import { StateGraph, START, END, MessagesAnnotation } from "@langchain/langgraph";
import { ToolNode } from "@langchain/langgraph/prebuilt";
import { SystemMessage, HumanMessage, AIMessage } from "@langchain/core/messages";
import { config } from "./config";
import { 
  sendAlertEmailTool, 
  sendReportEmailTool, 
  storeAlertRecordTool, 
  queryTagHistoryTool, 
  getProductionStatsTool 
} from "./tools";
import { 
  ALERT_ANALYSIS_PROMPT, 
  DAILY_INSIGHT_PROMPT, 
  MONTHLY_REPORT_PROMPT,
  FALLBACK_ALERT_TEMPLATE,
  FALLBACK_REPORT_TEMPLATE
} from "./prompts";
import { updateAlertLlmAnalysis, storeAlert, getDailyStats, getAlertsSince, getMonthlySummary, storeMonthlyReport } from "./db";

// Tools by context
const ALERT_TOOLS = [sendAlertEmailTool, storeAlertRecordTool, queryTagHistoryTool];
const REPORT_TOOLS = [sendReportEmailTool, getProductionStatsTool, queryTagHistoryTool];
const INSIGHT_TOOLS = [queryTagHistoryTool, getProductionStatsTool];

function createLlm() {
  return new ChatOllama({
    model: config.OLLAMA_MODEL,
    baseUrl: config.OLLAMA_BASE_URL,
    temperature: config.OLLAMA_TEMPERATURE,
    // Note: num_ctx argument depends on the exact `@langchain/ollama` version API, 
    // but typically passed in format param or environment.
  });
}

async function isOllamaAvailable(): Promise<boolean> {
  try {
    const res = await fetch(`${config.OLLAMA_BASE_URL}/api/tags`);
    if (res.ok) {
      const data = await res.json();
      const modelNames = data.models.map((m: any) => m.name.split(":")[0]);
      const target = config.OLLAMA_MODEL.split(":")[0];
      return modelNames.includes(target);
    }
    return false;
  } catch (err) {
    return false;
  }
}

function buildAgentGraph(systemPrompt: string, tools: any[]) {
  const llm = createLlm();
  const llmWithTools = llm.bindTools(tools);

  const analyzeNode = async (state: typeof MessagesAnnotation.State) => {
    let messages = state.messages;
    if (messages.length === 0 || !(messages[0] instanceof SystemMessage)) {
      messages = [new SystemMessage(systemPrompt), ...messages];
    }
    const response = await llmWithTools.invoke(messages);
    return { messages: [response] };
  };

  const shouldContinue = (state: typeof MessagesAnnotation.State) => {
    const messages = state.messages;
    const lastMessage = messages[messages.length - 1] as AIMessage;
    if (lastMessage.tool_calls && lastMessage.tool_calls.length > 0) {
      return "tools";
    }
    return END;
  };

  const workflow = new StateGraph(MessagesAnnotation)
    .addNode("analyze", analyzeNode)
    .addNode("tools", new ToolNode(tools))
    .addEdge(START, "analyze")
    .addConditionalEdges("analyze", shouldContinue)
    .addEdge("tools", "analyze");

  return workflow.compile();
}

let alertAgent: any = null;
let reportAgent: any = null;
let insightAgent: any = null;

function getAlertAgent() {
  if (!alertAgent) alertAgent = buildAgentGraph(ALERT_ANALYSIS_PROMPT, ALERT_TOOLS);
  return alertAgent;
}

function getReportAgent() {
  if (!reportAgent) reportAgent = buildAgentGraph(MONTHLY_REPORT_PROMPT, REPORT_TOOLS);
  return reportAgent;
}

function getInsightAgent() {
  if (!insightAgent) insightAgent = buildAgentGraph(DAILY_INSIGHT_PROMPT, INSIGHT_TOOLS);
  return insightAgent;
}

export async function analyzeAlert(alertData: any): Promise<string> {
  // Store alert first
  const alertId = storeAlert(alertData);

  const isAvailable = await isOllamaAvailable();
  if (!isAvailable) {
    console.warn("[LLM] Ollama not available — using fallback alert template");
    const fallback = _formatFallbackAlert(alertData);
    // Directly send email
    sendAlertEmailTool.invoke({
        subject: `[${alertData.level || "WARNING"}] Nonwoven Machine Alert — ${alertData.label}`,
        body: fallback,
        severity: alertData.level || "WARNING"
    });
    return fallback;
  }

  try {
    const agent = getAlertAgent();
    const dataMessage = `ALERT DETECTED — Analyze and respond.\n\nTAG: ${alertData.tag}\nCOMPONENT: ${alertData.label}\nCURRENT VALUE: ${alertData.value} ${alertData.unit}\nSEVERITY: ${alertData.level}\nDETECTION REASON: ${alertData.message}\nTIMESTAMP: ${alertData.timestamp}\n\nINSTRUCTIONS:\n1. Analyze this alert based on the machine operating ranges.\n2. Use the send_alert_email tool to notify factory management.\n3. Use the store_alert_record tool to log this alert.`;
    
    const result = await agent.invoke({
      messages: [new HumanMessage(dataMessage)]
    });

    const analysis = _extractFinalResponse(result);
    updateAlertLlmAnalysis(alertId, analysis);
    console.log(`[LLM] Alert analyzed: ${alertData.tag} — ${alertData.level}`);
    return analysis;
  } catch (e: any) {
    console.error(`[LLM] Alert analysis failed:`, e);
    if (config.LLM_FALLBACK_ENABLED) {
        const fallback = _formatFallbackAlert(alertData);
        sendAlertEmailTool.invoke({
            subject: `[${alertData.level || "WARNING"}] Nonwoven Machine Alert — ${alertData.label}`,
            body: fallback,
            severity: alertData.level || "WARNING"
        });
        return fallback;
    }
    return `Alert analysis failed: ${e.message}`;
  }
}

export async function generateDailyInsights(dateStr?: string): Promise<string> {
  if (!dateStr) dateStr = new Date().toISOString().split("T")[0];
  
  const todayStats = getDailyStats(dateStr);
  if (Object.keys(todayStats).length === 0) return "No data available for insight generation.";

  const historicalStats: any = {};
  for (let i = 1; i <= 7; i++) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    const pastDate = d.toISOString().split("T")[0];
    const pastStats = getDailyStats(pastDate);
    for (const [tag, vals] of Object.entries(pastStats)) {
      if (!historicalStats[tag]) historicalStats[tag] = [];
      if (vals.avg !== null) historicalStats[tag].push(vals.avg);
    }
  }

  const histAvgs: any = {};
  for (const [tag, values] of Object.entries(historicalStats)) {
    if ((values as number[]).length > 0) {
      const sum = (values as number[]).reduce((a,b) => a+b, 0);
      histAvgs[tag] = Number((sum / (values as number[]).length).toFixed(3));
    }
  }

  const todayAlerts = getAlertsSince(24);
  const isAvailable = await isOllamaAvailable();
  if (!isAvailable) {
    console.warn("[LLM] Ollama not available — skipping daily insights");
    return "LLM unavailable — daily insights not generated.";
  }

  try {
    const agent = getInsightAgent();
    const dataMessage = `DATE: ${dateStr}\n\nTODAY'S STATISTICS:\n${JSON.stringify(todayStats, null, 2)}\n\n7-DAY HISTORICAL AVERAGES:\n${JSON.stringify(histAvgs, null, 2)}\n\nTODAY'S ALERT COUNT: ${todayAlerts.length}`;
    
    const result = await agent.invoke({
      messages: [new HumanMessage(dataMessage)]
    });

    const insights = _extractFinalResponse(result);
    console.log(`[LLM] Daily insights generated for ${dateStr}`);
    return insights;
  } catch (e: any) {
    console.error(`[LLM] Daily insight generation failed:`, e);
    return `Insight generation failed: ${e.message}`;
  }
}

export async function generateMonthlyReport(year?: number, month?: number): Promise<string> {
  const now = new Date();
  if (!year || !month) {
    if (now.getMonth() === 0) {
      year = now.getFullYear() - 1;
      month = 12;
    } else {
      year = now.getFullYear();
      month = now.getMonth(); // 0-indexed, so getMonth() is the previous month (1-based mapping happens inside)
    }
  }

  console.log(`Generating monthly report for ${year}-${month.toString().padStart(2, "0")}`);
  const monthlyData = getMonthlySummary(year, month);

  const isAvailable = await isOllamaAvailable();
  if (!isAvailable) {
    console.warn("[LLM] Ollama not available — using fallback report template");
    const reportHtml = _generateFallbackReport(year, month, monthlyData);
    storeMonthlyReport(year, month, reportHtml, monthlyData);
    sendReportEmailTool.invoke({
        subject: `Monthly Production Report — ${getMonthName(month)} ${year}`,
        html_body: reportHtml
    });
    return reportHtml;
  }

  try {
    const agent = getReportAgent();
    const dataMessage = `REPORT PERIOD: ${getMonthName(month)} ${year}\n\nMONTHLY DATA:\n${JSON.stringify(monthlyData, null, 2)}`;
    
    const result = await agent.invoke({
      messages: [new HumanMessage(dataMessage)]
    });

    const reportContent = _extractFinalResponse(result);
    storeMonthlyReport(year, month, reportContent, monthlyData);
    console.log(`[LLM] Monthly report generated for ${getMonthName(month)} ${year}`);
    return reportContent;
  } catch (e: any) {
    console.error(`[LLM] Monthly report generation failed:`, e);
    const reportHtml = _generateFallbackReport(year, month, monthlyData);
    storeMonthlyReport(year, month, reportHtml, monthlyData);
    return reportHtml;
  }
}

function _extractFinalResponse(result: any): string {
  const messages = result.messages || [];
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg.content && (!msg.tool_calls || msg.tool_calls.length === 0)) {
      return msg.content;
    }
  }
  return "No response generated.";
}

function _formatFallbackAlert(data: any): string {
  return FALLBACK_ALERT_TEMPLATE
    .replace("{level}", data.level)
    .replace("{label}", data.label)
    .replace("{tag}", data.tag)
    .replace("{value}", data.value)
    .replace("{unit}", data.unit)
    .replace("{message}", data.message)
    .replace("{timestamp}", data.timestamp);
}

function _generateFallbackReport(year: number, month: number, data: any): string {
  const tagStats = data.tagStats || {};
  const alertCounts = data.alertCounts || {};

  let tagRows = "";
  for (const [tag, stats] of Object.entries(tagStats)) {
    const s: any = stats;
    tagRows += `<tr><td style="padding: 6px; border: 1px solid #ddd;">${tag}</td><td style="padding: 6px; border: 1px solid #ddd; text-align: center;">${s.min ?? "—"}</td><td style="padding: 6px; border: 1px solid #ddd; text-align: center;">${s.avg ?? "—"}</td><td style="padding: 6px; border: 1px solid #ddd; text-align: center;">${s.max ?? "—"}</td></tr>\n`;
  }

  let alertBreakdown = "";
  for (const [level, count] of Object.entries(alertCounts)) {
    alertBreakdown += `<li>${level}: ${count}</li>\n`;
  }
  if (!alertBreakdown) alertBreakdown = "<li>No alerts recorded</li>";

  return FALLBACK_REPORT_TEMPLATE
    .replace("{month_name}", getMonthName(month))
    .replace("{year}", String(year))
    .replace("{production_meters}", String(data.productionMeters || 0))
    .replace("{operating_days}", String(data.operatingDays || 0))
    .replace("{total_alerts}", String(data.totalAlerts || 0))
    .replace("{alert_breakdown}", alertBreakdown)
    .replace("{tag_stats_rows}", tagRows)
    .replace("{generated_at}", new Date().toISOString());
}

function getMonthName(month: number): string {
  const d = new Date();
  d.setMonth(month - 1);
  return d.toLocaleString("default", { month: "long" });
}
