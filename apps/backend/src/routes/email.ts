import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { requireApiAuth } from "../auth.js";
import { getSmtpTransport, smtpFromAddress, verifySmtpTransport } from "../email/smtpTransport.js";

const EmailTestBodySchema = z.object({
  to: z.string().email(),
  subject: z.string().min(1).max(200).optional(),
  text: z.string().min(1).max(5000).optional(),
  html: z.string().min(1).max(10000).optional(),
});

export async function registerEmailRoutes(app: FastifyInstance) {
  app.post("/email/test", async (req, reply) => {
    // requireApiAuth(req);

    const parsed = EmailTestBodySchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return reply.code(400).send({
        error: "invalid_request",
        issues: parsed.error.issues,
      });
    }

    const { to, subject, text, html } = parsed.data;
    const verification = await verifySmtpTransport();
    if (!verification.ok) {
      return reply.code(500).send({
        ok: false,
        error: "smtp_verification_failed",
        message: verification.message,
      });
    }

    const transport = getSmtpTransport();
    if (!transport) {
      return reply.code(500).send({
        ok: false,
        error: "smtp_transport_unavailable",
        message: "Failed to initialize SMTP transport from environment configuration.",
      });
    }

    const now = new Date().toISOString();
    const fallbackText = `Email route test succeeded.\n\nTime: ${now}`;
    const fallbackHtml = `<h3>Email route test succeeded</h3><p>Time: <strong>${now}</strong></p>`;

    try {
      const info = await transport.sendMail({
        from: smtpFromAddress("rvl-agent@localhost"),
        to,
        subject: subject ?? "RVL Lamination Agent — Email Route Test",
        text: text ?? fallbackText,
        html: html ?? fallbackHtml,
      });

      return reply.send({
        ok: true,
        message: `Test email sent to ${to}`,
        messageId: info.messageId,
      });
    } catch (err: any) {
      return reply.code(500).send({
        ok: false,
        error: "smtp_send_failed",
        message: String(err?.message ?? err),
      });
    }
  });
}
