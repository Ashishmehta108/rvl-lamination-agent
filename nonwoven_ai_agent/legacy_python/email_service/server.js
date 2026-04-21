/**
 * Nonwoven AI Agent — Email Service (Nodemailer)
 * 
 * Lightweight Express microservice that receives email requests
 * from the Python AI agent and sends them via SMTP (Nodemailer).
 * 
 * Endpoints:
 *   POST /send-email     — Send a single email (alert or report)
 *   GET  /health         — Health check
 * 
 * Security: Validates X-API-Key header against API_KEY env var.
 */

require("dotenv").config();
const express = require("express");
const nodemailer = require("nodemailer");
const cors = require("cors");

const app = express();
app.use(express.json({ limit: "5mb" }));
app.use(cors());

const PORT = process.env.PORT || 3001;
const API_KEY = process.env.API_KEY || "nonwoven-agent-secret-key";

// ── SMTP Transporter ─────────────────────────────────────────────

const transporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST || "smtp.gmail.com",
  port: parseInt(process.env.SMTP_PORT || "587"),
  secure: process.env.SMTP_SECURE === "true",
  auth: {
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS,
  },
  // Connection pool for better performance
  pool: true,
  maxConnections: 3,
  maxMessages: 100,
});

// Verify transporter on startup
transporter.verify((error, success) => {
  if (error) {
    console.error("❌ SMTP connection failed:", error.message);
    console.error("   Check your .env SMTP settings.");
    console.error("   The service will still start — emails will fail until SMTP is configured.");
  } else {
    console.log("✅ SMTP connection verified — ready to send emails.");
  }
});

// ── Middleware: API Key Authentication ────────────────────────────

function authenticate(req, res, next) {
  const key = req.headers["x-api-key"];
  if (!key || key !== API_KEY) {
    return res.status(401).json({ success: false, error: "Invalid or missing API key" });
  }
  next();
}

// ── Routes ───────────────────────────────────────────────────────

/**
 * POST /send-email
 * Body: { to, subject, text?, html?, priority? }
 */
app.post("/send-email", authenticate, async (req, res) => {
  const { to, subject, text, html, priority } = req.body;

  // Validate required fields
  if (!to || !subject) {
    return res.status(400).json({
      success: false,
      error: "Missing required fields: 'to' and 'subject' are required.",
    });
  }

  if (!text && !html) {
    return res.status(400).json({
      success: false,
      error: "At least one of 'text' or 'html' must be provided.",
    });
  }

  try {
    const mailOptions = {
      from: `"${process.env.SENDER_NAME || "Nonwoven AI Agent"}" <${process.env.SENDER_EMAIL || process.env.SMTP_USER}>`,
      to: to,
      subject: subject,
    };

    if (text) mailOptions.text = text;
    if (html) mailOptions.html = html;

    // Set email priority
    if (priority === "high") {
      mailOptions.priority = "high";
      mailOptions.headers = {
        "X-Priority": "1",
        "X-MSMail-Priority": "High",
        Importance: "high",
      };
    }

    const info = await transporter.sendMail(mailOptions);

    console.log(`📧 Email sent: [${subject}] → ${to} (ID: ${info.messageId})`);

    res.status(200).json({
      success: true,
      messageId: info.messageId,
      accepted: info.accepted,
    });
  } catch (error) {
    console.error(`❌ Email failed: ${error.message}`);
    res.status(500).json({
      success: false,
      error: `Failed to send email: ${error.message}`,
    });
  }
});

/**
 * GET /health
 * Simple health check for the Python agent to verify the service is up.
 */
app.get("/health", (req, res) => {
  res.status(200).json({
    status: "ok",
    service: "nonwoven-email-service",
    smtp_configured: !!(process.env.SMTP_USER && process.env.SMTP_PASS),
    uptime: Math.floor(process.uptime()),
  });
});

/**
 * GET /
 * Basic info endpoint.
 */
app.get("/", (req, res) => {
  res.json({
    service: "Nonwoven AI Agent — Email Service",
    version: "1.0.0",
    endpoints: {
      "POST /send-email": "Send an email (requires X-API-Key header)",
      "GET /health": "Health check",
    },
  });
});

// ── Start Server ─────────────────────────────────────────────────

app.listen(PORT, () => {
  console.log(`\n🚀 Nonwoven Email Service running on port ${PORT}`);
  console.log(`   Health check: http://localhost:${PORT}/health`);
  console.log(`   SMTP Host: ${process.env.SMTP_HOST || "(not configured)"}`);
  console.log(`   SMTP User: ${process.env.SMTP_USER || "(not configured)"}\n`);
});
