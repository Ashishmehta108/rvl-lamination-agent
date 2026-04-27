import nodemailer from "nodemailer";

export function isSmtpConfigured(): boolean {
  const host = process.env.SMTP_HOST;
  const port = process.env.SMTP_PORT;
  const user = process.env.SMTP_USER;
  const pass = process.env.SMTP_PASS;
  return Boolean(host && port && user && pass &&
    user !== "your-gmail@gmail.com" &&
    pass !== "your-16-char-app-password");
}

export function getSmtpTransport(): nodemailer.Transporter | null {
  const host = process.env.SMTP_HOST;
  const port = process.env.SMTP_PORT ? Number(process.env.SMTP_PORT) : undefined;
  const user = process.env.SMTP_USER;
  const pass = process.env.SMTP_PASS;

  if (!host || !port || !user || !pass) return null;
  if (user === "your-gmail@gmail.com" || pass === "your-16-char-app-password") return null;

  return nodemailer.createTransport({
    host,
    port,
    secure: process.env.SMTP_SECURE === "true",
    auth: { user, pass }
  });
}

export function smtpFromAddress(fallbackUser: string): string {
  const name = process.env.SENDER_NAME ?? "RVL Lamination Agent";
  const email = process.env.SENDER_EMAIL ?? fallbackUser;
  return `"${name}" <${email}>`;
}

/** Verifies the SMTP connection. Returns { ok, message }. */
export async function verifySmtpTransport(): Promise<{ ok: boolean; message: string }> {
  if (!isSmtpConfigured()) {
    return { ok: false, message: "SMTP not configured — fill in SMTP_HOST/PORT/USER/PASS in .env" };
  }
  const transport = getSmtpTransport();
  if (!transport) {
    return { ok: false, message: "Failed to create SMTP transport (check .env values)" };
  }
  try {
    await transport.verify();
    return { ok: true, message: "SMTP connection verified successfully" };
  } catch (err: any) {
    return { ok: false, message: String(err?.message ?? err) };
  }
}
