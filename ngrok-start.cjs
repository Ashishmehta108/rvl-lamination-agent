const { spawn } = require("child_process");

const proc = spawn(
    "cmd.exe",
    ["/c", "npx", "ngrok", "http", "7000"],
    {
        windowsHide: true,
        stdio: "inherit",
        shell: false
    }
);

proc.on("error", (err) => {
    console.error("Spawn error:", err);
});

proc.on("exit", (code) => {
    process.exit(code ?? 0);
});