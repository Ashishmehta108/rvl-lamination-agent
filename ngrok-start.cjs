const { spawn, execSync } = require("child_process");
const path = require("path");

// Load .env from project root
require("dotenv").config({ path: path.resolve(__dirname, ".env") });

const domain = process.env.NGROK_DOMAIN;
const args = ["/c", "npx", "ngrok", "http", "7000"];

if (domain) {
    args.push("--domain", domain);
}

const proc = spawn(
    "cmd.exe",
    args,
    {
        windowsHide: true,
        stdio: "inherit",
        shell: false
    }
);

function cleanup() {
    if (proc && proc.pid) {
        try {
            // Cleanly kill the entire child process tree on Windows to prevent orphaned ngrok.exe
            execSync(`taskkill /pid ${proc.pid} /t /f`, { stdio: "ignore" });
        } catch (e) {
            try {
                proc.kill();
            } catch (err) {}
        }
    }
}

// Handle parent termination signals from PM2 to ensure clean teardown
process.on("SIGINT", () => {
    cleanup();
    process.exit(0);
});

process.on("SIGTERM", () => {
    cleanup();
    process.exit(0);
});

process.on("exit", () => {
    cleanup();
});

proc.on("error", (err) => {
    console.error("Spawn error:", err);
});

proc.on("exit", (code) => {
    process.exit(code ?? 0);
});