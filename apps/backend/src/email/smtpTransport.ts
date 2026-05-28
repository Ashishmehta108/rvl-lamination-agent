import nodemailer from "nodemailer";

const SMTP_PLACEHOLDERS = {
  user: "your-gmail@gmail.com",
  pass: "your-16-char-app-password",
} as const;

type SmtpConfigState =
  | { ok: true; host: string; port: number; user: string; pass: string }
  | { ok: false; reason: "missing_fields" | "placeholder_values" | "invalid_port"; message: string };

function readSmtpConfig(): SmtpConfigState {
  const host = process.env.SMTP_HOST?.trim();
  const rawPort = process.env.SMTP_PORT?.trim();
  const user = process.env.SMTP_USER?.trim();
  const pass = process.env.SMTP_PASS?.trim();

  if (!host || !rawPort || !user || !pass) {
    return {
      ok: false,
      reason: "missing_fields",
      message: "SMTP not configured — set SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS in .env",
    };
  }

  

  if (user === SMTP_PLACEHOLDERS.user || pass === SMTP_PLACEHOLDERS.pass) {
    return {
      ok: false,
      reason: "placeholder_values",
      message: "SMTP placeholders detected — replace SMTP_USER/SMTP_PASS with real credentials",
    };
  }

  const port = Number(rawPort);
  if (!Number.isFinite(port) || port <= 0) {
    return {
      ok: false,
      reason: "invalid_port",
      message: "SMTP_PORT must be a valid positive number",
    };
  }

  return { ok: true, host, port, user, pass };
}

export function isSmtpConfigured(): boolean {
  return readSmtpConfig().ok;
}

export function getSmtpTransport(): nodemailer.Transporter | null {
  const cfg = readSmtpConfig();
  if (!cfg.ok) return null;

  return nodemailer.createTransport({
    host: cfg.host,
    port: cfg.port,
    secure: process.env.SMTP_SECURE === "true",
    auth: { user: cfg.user, pass: cfg.pass }
  });
}

export function smtpFromAddress(fallbackUser: string): string {
  const name = process.env.SENDER_NAME ?? "RVL Lamination Agent";
  const email = process.env.SENDER_EMAIL ?? fallbackUser;
  return `"${name}" <${email}>`;
}

/** Verifies the SMTP connection. Returns { ok, message }. */
export async function verifySmtpTransport(): Promise<{ ok: boolean; message: string }> {
  const cfg = readSmtpConfig();
  if (!cfg.ok) {
    return { ok: false, message: cfg.message };
  }
  const transport = getSmtpTransport();
  if (!transport) {
    return { ok: false, message: "Failed to create SMTP transport from configured values" };
  }
  try {
    await transport.verify();
    return { ok: true, message: "SMTP connection verified successfully" };
  } catch (err: any) {
    return { ok: false, message: String(err?.message ?? err) };
  }
}