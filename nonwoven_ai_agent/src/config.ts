import dotenv from "dotenv";
dotenv.config();

function getEnv(key: string, defaultValue: string = ""): string {
  return process.env[key] || defaultValue;
}

function getEnvNum(key: string, defaultValue: number): number {
  const val = process.env[key];
  if (val !== undefined && val !== "") {
    const num = Number(val);
    if (!isNaN(num)) return num;
  }
  return defaultValue;
}

function getEnvBool(key: string, defaultValue: boolean): boolean {
  const val = process.env[key];
  if (val !== undefined) {
    return val.toLowerCase() === "true";
  }
  return defaultValue;
}

export const config = {
  // Simulation
  SIMULATION_MODE: getEnvBool("SIMULATION_MODE", true),

  // Ollama
  OLLAMA_BASE_URL: getEnv("OLLAMA_BASE_URL", "http://localhost:11434"),
  OLLAMA_MODEL: getEnv("OLLAMA_MODEL", "qwen3:4b"),
  OLLAMA_NUM_CTX: getEnvNum("OLLAMA_NUM_CTX", 8192),
  OLLAMA_TEMPERATURE: getEnvNum("OLLAMA_TEMPERATURE", 0),

  // HMI
  HMI_IP: getEnv("HMI_IP", "192.168.1.17"),
  HMI_PORT: getEnvNum("HMI_PORT", 502),

  // Email
  ALERT_RECIPIENTS: getEnv("ALERT_RECIPIENTS", "")
    .split(",")
    .map((e) => e.trim())
    .filter((e) => e.length > 0),
  REPORT_RECIPIENTS: getEnv("REPORT_RECIPIENTS", "")
    .split(",")
    .map((e) => e.trim())
    .filter((e) => e.length > 0),
  SMTP_HOST: getEnv("SMTP_HOST", "smtp.gmail.com"),
  SMTP_PORT: getEnvNum("SMTP_PORT", 587),
  SMTP_SECURE: getEnvBool("SMTP_SECURE", false),
  SMTP_USER: getEnv("SMTP_USER", ""),
  SMTP_PASS: getEnv("SMTP_PASS", ""),
  SENDER_EMAIL: getEnv("SENDER_EMAIL", ""),
  SENDER_NAME: getEnv("SENDER_NAME", "Nonwoven AI Agent"),

  // DB
  DB_PATH: getEnv("DB_PATH", "nonwoven_data.db"),

  // Timing
  MODBUS_POLL_INTERVAL: getEnvNum("MODBUS_POLL_INTERVAL", 2),
  DB_SAMPLE_INTERVAL: getEnvNum("DB_SAMPLE_INTERVAL", 30),
  ANOMALY_CHECK_INTERVAL: getEnvNum("ANOMALY_CHECK_INTERVAL", 30),
  ALERT_COOLDOWN_SECONDS: getEnvNum("ALERT_COOLDOWN_SECONDS", 300),

  // Server
  EXPRESS_PORT: getEnvNum("EXPRESS_PORT", 5000),

  // Agent fallbacks
  LLM_FALLBACK_ENABLED: getEnvBool("LLM_FALLBACK_ENABLED", true),
};
