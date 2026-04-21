"""
LangGraph Agent for the Nonwoven Lamination Machine.

Uses a StateGraph with Ollama (Qwen3:4b) and custom tools for:
  - Analyzing anomalies and composing alert messages
  - Sending emails via the Nodemailer service
  - Querying historical data for context
  - Generating monthly reports and daily insights

The agent is invoked by the scheduler — it does NOT run in a loop itself.
"""

import json
import time
import logging
import requests
from typing import Optional, Annotated
from datetime import datetime, timedelta

from langchain_core.messages import HumanMessage, SystemMessage
from langchain_core.tools import tool
from langchain_ollama import ChatOllama
from langgraph.graph import StateGraph, START, END, MessagesState
from langgraph.prebuilt import ToolNode, tools_condition

from config import (
    OLLAMA_BASE_URL, OLLAMA_MODEL, OLLAMA_NUM_CTX, OLLAMA_TEMPERATURE,
    EMAIL_SERVICE_URL, EMAIL_API_KEY,
    ALERT_RECIPIENTS, REPORT_RECIPIENTS,
    LLM_FALLBACK_ENABLED, LLM_MAX_RETRIES, LLM_TIMEOUT,
)
from prompts import (
    ALERT_ANALYSIS_PROMPT, MONTHLY_REPORT_PROMPT,
    DAILY_INSIGHT_PROMPT, ALERT_EMAIL_PROMPT,
    FALLBACK_ALERT_TEMPLATE, FALLBACK_REPORT_TEMPLATE,
)
import database as db

logger = logging.getLogger("langgraph_agent")


# ═══════════════════════════════════════════════════════════════════
# TOOLS — These are the actions the LLM can take
# ═══════════════════════════════════════════════════════════════════

@tool
def send_alert_email(subject: str, body: str, severity: str) -> str:
    """Send an alert email to factory management. Use this when an alert needs to be communicated.
    Args:
        subject: Email subject line including severity and component
        body: Email body text describing the alert, current values, and recommended action
        severity: Alert severity level — one of CRITICAL, ALARM, WARNING, ANOMALY
    """
    if not ALERT_RECIPIENTS:
        return "No alert recipients configured. Email not sent."

    try:
        payload = {
            "to": ", ".join(ALERT_RECIPIENTS),
            "subject": subject,
            "text": body,
            "html": _wrap_alert_html(body, severity),
            "priority": "high" if severity in ("CRITICAL", "ALARM") else "normal",
        }
        headers = {
            "Content-Type": "application/json",
            "X-API-Key": EMAIL_API_KEY,
        }
        resp = requests.post(
            f"{EMAIL_SERVICE_URL}/send-email",
            json=payload, headers=headers, timeout=10
        )
        if resp.status_code == 200:
            return f"Alert email sent successfully to {', '.join(ALERT_RECIPIENTS)}"
        else:
            return f"Email service returned status {resp.status_code}: {resp.text}"
    except requests.ConnectionError:
        return "Email service unavailable (connection refused). Email not sent."
    except Exception as e:
        return f"Failed to send email: {str(e)}"


@tool
def send_report_email(subject: str, html_body: str) -> str:
    """Send a monthly report email with an HTML body.
    Args:
        subject: Email subject line for the monthly report
        html_body: Complete HTML content of the monthly report
    """
    if not REPORT_RECIPIENTS:
        return "No report recipients configured. Email not sent."

    try:
        payload = {
            "to": ", ".join(REPORT_RECIPIENTS),
            "subject": subject,
            "html": html_body,
            "priority": "normal",
        }
        headers = {
            "Content-Type": "application/json",
            "X-API-Key": EMAIL_API_KEY,
        }
        resp = requests.post(
            f"{EMAIL_SERVICE_URL}/send-email",
            json=payload, headers=headers, timeout=15
        )
        if resp.status_code == 200:
            return f"Report email sent successfully to {', '.join(REPORT_RECIPIENTS)}"
        else:
            return f"Email service returned status {resp.status_code}: {resp.text}"
    except requests.ConnectionError:
        return "Email service unavailable (connection refused). Report not sent."
    except Exception as e:
        return f"Failed to send report email: {str(e)}"


@tool
def store_alert_record(tag: str, severity: str, message: str, value: float, unit: str) -> str:
    """Store an alert record in the database for tracking and reporting.
    Args:
        tag: Machine tag identifier (e.g., EXTRUDER_AMP, WINDER_FAULT)
        severity: Alert severity — CRITICAL, ALARM, WARNING, ANOMALY, or FAULT
        message: Human-readable alert message
        value: Current sensor value that triggered the alert
        unit: Unit of measurement (A, RPM, %, m/min, etc.)
    """
    try:
        alert_id = db.store_alert({
            "timestamp": datetime.now().isoformat(),
            "tag": tag,
            "label": tag.replace("_", " ").title(),
            "value": value,
            "unit": unit,
            "level": severity,
            "message": message,
        })
        return f"Alert stored in database with ID {alert_id}"
    except Exception as e:
        return f"Failed to store alert: {str(e)}"


@tool
def query_tag_history(tag_name: str, hours: int = 1) -> str:
    """Query recent sensor readings for a specific tag. Use this to get historical context.
    Args:
        tag_name: The tag to query (e.g., EXTRUDER_AMP, LAMINATOR_MPM)
        hours: How many hours of history to retrieve (default 1, max 24)
    """
    hours = min(hours, 24)
    try:
        readings = db.get_recent_readings(tag_name, hours)
        if not readings:
            return f"No readings found for {tag_name} in the last {hours} hour(s)."

        values = [r["value"] for r in readings]
        summary = {
            "tag": tag_name,
            "period_hours": hours,
            "sample_count": len(values),
            "min": round(min(values), 3),
            "max": round(max(values), 3),
            "avg": round(sum(values) / len(values), 3),
            "latest": round(values[-1], 3),
            "unit": readings[0].get("unit", ""),
        }
        return json.dumps(summary)
    except Exception as e:
        return f"Error querying history: {str(e)}"


@tool
def get_production_stats(period: str = "today") -> str:
    """Get aggregated production statistics for a given period.
    Args:
        period: Either 'today' or 'YYYY-MM-DD' for a specific date
    """
    try:
        if period == "today":
            date_str = datetime.now().strftime("%Y-%m-%d")
        else:
            date_str = period

        stats = db.get_daily_stats(date_str)
        if not stats:
            return f"No production data available for {date_str}."
        return json.dumps(stats, indent=2)
    except Exception as e:
        return f"Error getting production stats: {str(e)}"


# ── All available tools ──────────────────────────────────────────
ALL_TOOLS = [
    send_alert_email,
    send_report_email,
    store_alert_record,
    query_tag_history,
    get_production_stats,
]

# Tools available for alert analysis (subset — no report sending)
ALERT_TOOLS = [
    send_alert_email,
    store_alert_record,
    query_tag_history,
]

# Tools for report generation
REPORT_TOOLS = [
    send_report_email,
    get_production_stats,
    query_tag_history,
]

# Tools for daily insights (read-only)
INSIGHT_TOOLS = [
    query_tag_history,
    get_production_stats,
]


# ═══════════════════════════════════════════════════════════════════
# LLM SETUP
# ═══════════════════════════════════════════════════════════════════

def _create_llm():
    """Create the ChatOllama instance."""
    return ChatOllama(
        model=OLLAMA_MODEL,
        base_url=OLLAMA_BASE_URL,
        temperature=OLLAMA_TEMPERATURE,
        num_ctx=OLLAMA_NUM_CTX,
        timeout=LLM_TIMEOUT,
    )


def _is_ollama_available() -> bool:
    """Check if Ollama is running and the model is loaded."""
    try:
        resp = requests.get(f"{OLLAMA_BASE_URL}/api/tags", timeout=5)
        if resp.status_code == 200:
            models = resp.json().get("models", [])
            model_names = [m.get("name", "").split(":")[0] for m in models]
            target = OLLAMA_MODEL.split(":")[0]
            return target in model_names
        return False
    except Exception:
        return False


# ═══════════════════════════════════════════════════════════════════
# GRAPH BUILDERS — One graph per task type for safety
# ═══════════════════════════════════════════════════════════════════

def _build_agent_graph(system_prompt: str, tools: list):
    """Build a LangGraph StateGraph for a specific task type."""
    llm = _create_llm()
    llm_with_tools = llm.bind_tools(tools)

    def analyze_node(state: MessagesState):
        """The main LLM node — processes messages and decides on tool calls."""
        messages = state["messages"]
        # Ensure system prompt is always first
        if not messages or not isinstance(messages[0], SystemMessage):
            messages = [SystemMessage(content=system_prompt)] + messages
        response = llm_with_tools.invoke(messages)
        return {"messages": [response]}

    graph = StateGraph(MessagesState)
    graph.add_node("analyze", analyze_node)
    graph.add_node("tools", ToolNode(tools))
    graph.add_edge(START, "analyze")
    graph.add_conditional_edges("analyze", tools_condition)
    graph.add_edge("tools", "analyze")

    return graph.compile()


# Lazy-initialized agent instances
_alert_agent = None
_report_agent = None
_insight_agent = None


def _get_alert_agent():
    global _alert_agent
    if _alert_agent is None:
        _alert_agent = _build_agent_graph(ALERT_ANALYSIS_PROMPT, ALERT_TOOLS)
    return _alert_agent


def _get_report_agent():
    global _report_agent
    if _report_agent is None:
        _report_agent = _build_agent_graph(MONTHLY_REPORT_PROMPT, REPORT_TOOLS)
    return _report_agent


def _get_insight_agent():
    global _insight_agent
    if _insight_agent is None:
        _insight_agent = _build_agent_graph(DAILY_INSIGHT_PROMPT, INSIGHT_TOOLS)
    return _insight_agent


# ═══════════════════════════════════════════════════════════════════
# PUBLIC API — Called by the scheduler
# ═══════════════════════════════════════════════════════════════════

def analyze_alert(alert_data: dict) -> str:
    """
    Invoke the LangGraph agent to analyze an alert and compose/send notifications.

    Args:
        alert_data: Dict with keys: tag, label, value, unit, level, message

    Returns:
        The LLM's analysis text, or a fallback message if LLM is unavailable.
    """
    # First, store the alert in DB regardless of LLM availability
    alert_id = db.store_alert(alert_data)

    # Check if LLM is available
    if not _is_ollama_available():
        logger.warning("Ollama not available — using fallback alert template")
        fallback = FALLBACK_ALERT_TEMPLATE.format(**alert_data)
        _send_fallback_alert_email(alert_data, fallback)
        return fallback

    try:
        agent = _get_alert_agent()
        # Compose the data message for the LLM
        data_message = _format_alert_for_llm(alert_data)

        result = agent.invoke({
            "messages": [
                SystemMessage(content=ALERT_ANALYSIS_PROMPT),
                HumanMessage(content=data_message),
            ]
        })

        # Extract the LLM's response
        analysis = _extract_final_response(result)
        db.update_alert_llm_analysis(alert_id, analysis)

        logger.info(f"[LLM] Alert analyzed: {alert_data['tag']} — {alert_data['level']}")
        return analysis

    except Exception as e:
        logger.error(f"LLM alert analysis failed: {e}")
        if LLM_FALLBACK_ENABLED:
            fallback = FALLBACK_ALERT_TEMPLATE.format(**alert_data)
            _send_fallback_alert_email(alert_data, fallback)
            return fallback
        return f"Alert analysis failed: {e}"


def generate_daily_insights(date_str: str = None) -> str:
    """
    Generate daily insights by comparing today's stats with historical averages.

    Args:
        date_str: Date to analyze (default: today). Format: YYYY-MM-DD

    Returns:
        Insight text from the LLM.
    """
    if date_str is None:
        date_str = datetime.now().strftime("%Y-%m-%d")

    # Get today's stats
    today_stats = db.get_daily_stats(date_str)
    if not today_stats:
        return "No data available for insight generation."

    # Get historical averages (last 7 days excluding today)
    historical_stats = {}
    for i in range(1, 8):
        past_date = (datetime.now() - timedelta(days=i)).strftime("%Y-%m-%d")
        past_stats = db.get_daily_stats(past_date)
        for tag, vals in past_stats.items():
            if tag not in historical_stats:
                historical_stats[tag] = []
            if vals.get("avg") is not None:
                historical_stats[tag].append(vals["avg"])

    hist_avgs = {}
    for tag, values in historical_stats.items():
        if values:
            hist_avgs[tag] = round(sum(values) / len(values), 3)

    # Get alert count for today
    today_alerts = db.get_alerts_since(24)

    if not _is_ollama_available():
        logger.warning("Ollama not available — skipping daily insights")
        return "LLM unavailable — daily insights not generated."

    try:
        agent = _get_insight_agent()
        data_message = (
            f"DATE: {date_str}\n\n"
            f"TODAY'S STATISTICS:\n{json.dumps(today_stats, indent=2)}\n\n"
            f"7-DAY HISTORICAL AVERAGES:\n{json.dumps(hist_avgs, indent=2)}\n\n"
            f"TODAY'S ALERT COUNT: {len(today_alerts)}"
        )

        result = agent.invoke({
            "messages": [
                SystemMessage(content=DAILY_INSIGHT_PROMPT),
                HumanMessage(content=data_message),
            ]
        })

        insights = _extract_final_response(result)
        logger.info(f"[LLM] Daily insights generated for {date_str}")
        return insights

    except Exception as e:
        logger.error(f"Daily insight generation failed: {e}")
        return f"Insight generation failed: {e}"


def generate_monthly_report(year: int = None, month: int = None) -> str:
    """
    Generate and email a monthly production report.

    Args:
        year: Report year. Defaults to previous month.
        month: Report month. Defaults to previous month.

    Returns:
        The report HTML or an error message.
    """
    # Default to last month
    if year is None or month is None:
        now = datetime.now()
        if now.month == 1:
            year, month = now.year - 1, 12
        else:
            year, month = now.year, now.month - 1

    logger.info(f"Generating monthly report for {year}-{month:02d}")

    # Gather monthly data from DB
    monthly_data = db.get_monthly_summary(year, month)

    if not _is_ollama_available():
        logger.warning("Ollama not available — using fallback report template")
        report_html = _generate_fallback_report(year, month, monthly_data)
        db.store_monthly_report(year, month, report_html, monthly_data)
        _send_fallback_report_email(year, month, report_html)
        return report_html

    try:
        agent = _get_report_agent()
        data_message = (
            f"REPORT PERIOD: {_month_name(month)} {year}\n\n"
            f"MONTHLY DATA:\n{json.dumps(monthly_data, indent=2, default=str)}"
        )

        result = agent.invoke({
            "messages": [
                SystemMessage(content=MONTHLY_REPORT_PROMPT),
                HumanMessage(content=data_message),
            ]
        })

        report_content = _extract_final_response(result)

        # Store the report
        db.store_monthly_report(year, month, report_content, monthly_data)
        logger.info(f"[LLM] Monthly report generated for {_month_name(month)} {year}")
        return report_content

    except Exception as e:
        logger.error(f"Monthly report generation failed: {e}")
        report_html = _generate_fallback_report(year, month, monthly_data)
        db.store_monthly_report(year, month, report_html, monthly_data)
        return report_html


# ═══════════════════════════════════════════════════════════════════
# HELPER FUNCTIONS
# ═══════════════════════════════════════════════════════════════════

def _format_alert_for_llm(alert_data: dict) -> str:
    """Format alert data as a clear, structured message for the LLM."""
    return (
        f"ALERT DETECTED — Analyze and respond.\n\n"
        f"TAG: {alert_data.get('tag', 'UNKNOWN')}\n"
        f"COMPONENT: {alert_data.get('label', 'Unknown')}\n"
        f"CURRENT VALUE: {alert_data.get('value', 'N/A')} {alert_data.get('unit', '')}\n"
        f"SEVERITY: {alert_data.get('level', 'WARNING')}\n"
        f"DETECTION REASON: {alert_data.get('message', 'Threshold exceeded')}\n"
        f"TIMESTAMP: {alert_data.get('timestamp', datetime.now().isoformat())}\n\n"
        f"INSTRUCTIONS:\n"
        f"1. Analyze this alert based on the machine operating ranges.\n"
        f"2. Use the send_alert_email tool to notify factory management.\n"
        f"3. Use the store_alert_record tool to log this alert."
    )


def _extract_final_response(result: dict) -> str:
    """Extract the final text response from a LangGraph result."""
    messages = result.get("messages", [])
    # Find the last AI message that isn't a tool call
    for msg in reversed(messages):
        if hasattr(msg, "content") and msg.content and not hasattr(msg, "tool_calls"):
            return msg.content
        elif hasattr(msg, "content") and msg.content and hasattr(msg, "tool_calls") and not msg.tool_calls:
            return msg.content
    return "No response generated."


def _wrap_alert_html(body_text: str, severity: str) -> str:
    """Wrap a plain-text alert in a styled HTML email."""
    severity_colors = {
        "CRITICAL": "#dc2626",
        "ALARM": "#ea580c",
        "WARNING": "#d97706",
        "ANOMALY": "#2563eb",
        "FAULT": "#9333ea",
    }
    color = severity_colors.get(severity, "#6b7280")

    return f"""
    <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
        <div style="background: {color}; color: white; padding: 16px 24px; border-radius: 8px 8px 0 0;">
            <h2 style="margin: 0;">⚠️ {severity} ALERT</h2>
            <p style="margin: 4px 0 0; opacity: 0.9;">Nonwoven Lamination Machine</p>
        </div>
        <div style="background: #f8f9fa; padding: 24px; border: 1px solid #e5e7eb; border-top: none; border-radius: 0 0 8px 8px;">
            <pre style="white-space: pre-wrap; font-family: monospace; font-size: 14px; line-height: 1.6;">{body_text}</pre>
        </div>
        <p style="color: #9ca3af; font-size: 12px; text-align: center; margin-top: 12px;">
            Auto-generated by Nonwoven AI Agent — {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}
        </p>
    </div>
    """


def _send_fallback_alert_email(alert_data: dict, body_text: str):
    """Send alert email without LLM (direct API call)."""
    if not ALERT_RECIPIENTS:
        return
    try:
        severity = alert_data.get("level", "WARNING")
        label = alert_data.get("label", "Unknown")
        payload = {
            "to": ", ".join(ALERT_RECIPIENTS),
            "subject": f"[{severity}] Nonwoven Machine Alert — {label}",
            "text": body_text,
            "html": _wrap_alert_html(body_text, severity),
            "priority": "high" if severity in ("CRITICAL", "ALARM") else "normal",
        }
        headers = {"Content-Type": "application/json", "X-API-Key": EMAIL_API_KEY}
        requests.post(f"{EMAIL_SERVICE_URL}/send-email", json=payload, headers=headers, timeout=10)
    except Exception as e:
        logger.error(f"Fallback alert email failed: {e}")


def _send_fallback_report_email(year: int, month: int, report_html: str):
    """Send report email without LLM."""
    if not REPORT_RECIPIENTS:
        return
    try:
        payload = {
            "to": ", ".join(REPORT_RECIPIENTS),
            "subject": f"Monthly Production Report — {_month_name(month)} {year}",
            "html": report_html,
            "priority": "normal",
        }
        headers = {"Content-Type": "application/json", "X-API-Key": EMAIL_API_KEY}
        requests.post(f"{EMAIL_SERVICE_URL}/send-email", json=payload, headers=headers, timeout=15)
    except Exception as e:
        logger.error(f"Fallback report email failed: {e}")


def _generate_fallback_report(year: int, month: int, data: dict) -> str:
    """Generate a report using the template (no LLM)."""
    tag_stats = data.get("tag_stats", {})
    alert_counts = data.get("alert_counts", {})

    tag_rows = ""
    for tag, stats in tag_stats.items():
        tag_rows += (
            f'<tr><td style="padding: 6px; border: 1px solid #ddd;">{tag}</td>'
            f'<td style="padding: 6px; border: 1px solid #ddd; text-align: center;">{stats.get("min", "—")}</td>'
            f'<td style="padding: 6px; border: 1px solid #ddd; text-align: center;">{stats.get("avg", "—")}</td>'
            f'<td style="padding: 6px; border: 1px solid #ddd; text-align: center;">{stats.get("max", "—")}</td></tr>\n'
        )

    alert_breakdown = ""
    for level, count in alert_counts.items():
        alert_breakdown += f"<li>{level}: {count}</li>\n"
    if not alert_breakdown:
        alert_breakdown = "<li>No alerts recorded</li>"

    return FALLBACK_REPORT_TEMPLATE.format(
        month_name=_month_name(month),
        year=year,
        production_meters=data.get("production_meters", 0),
        operating_days=data.get("operating_days", 0),
        total_alerts=data.get("total_alerts", 0),
        alert_breakdown=alert_breakdown,
        tag_stats_rows=tag_rows,
        generated_at=datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
    )


def _month_name(month: int) -> str:
    """Return full month name from number."""
    import calendar
    return calendar.month_name[month]
