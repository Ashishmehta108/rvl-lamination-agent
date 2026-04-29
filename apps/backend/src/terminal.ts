import readline from "readline";

// Use global fetch (Node 18+). If not available, install node-fetch.

// ----------------------
// CONFIG
// ----------------------
const OLLAMA_URL = "http://localhost:11434/api/chat";
const MODEL = "lfm2.5-thinking:latest";

// ----------------------
// MEMORY (with system prompt)
// ----------------------
const history: any[] = [
  {
    role: "system",
    content:
      "You are a precise reasoning assistant. Think step-by-step but respond concisely.",
  },
];

// ----------------------
// READLINE SETUP
// ----------------------
const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
});

// Abort controller for cancelling generation
let controller: AbortController | null = null;

// ----------------------
// LLM CALL (STREAMING SAFE)
// ----------------------
async function askLLM(prompt: string) {
  history.push({ role: "user", content: prompt });

  controller = new AbortController();

  const res = await fetch(OLLAMA_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    signal: controller.signal,
    body: JSON.stringify({
      model: MODEL,
      messages: history,
      stream: true,
      options: {
        temperature: 0.7,
        num_ctx: 4096,
      },
    }),
  });

  if (!res.body) {
    throw new Error("No response body from Ollama");
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();

  let buffer = "";
  let fullResponse = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });

    const lines = buffer.split("\n");
    buffer = lines.pop() || ""; // keep incomplete chunk

    for (const line of lines) {
      if (!line.trim()) continue;

      try {
        const data = JSON.parse(line);

        if (data.message?.content) {
          process.stdout.write(data.message.content);
          fullResponse += data.message.content;
        }

        if (data.done) {
          console.log("\n");
        }
      } catch {
        // ignore incomplete JSON
      }
    }
  }

  history.push({ role: "assistant", content: fullResponse });

  // prevent memory explosion (keep last 20 messages)
  if (history.length > 20) {
    history.splice(1, history.length - 20);
  }
}

// ----------------------
// CHAT LOOP
// ----------------------
function chat() {
  rl.question("You: ", async (input) => {
    if (input.toLowerCase() === "exit") {
      rl.close();
      return;
    }

    try {
      process.stdout.write("AI: ");
      await askLLM(input);
    } catch (err: any) {
      if (err.name === "AbortError") {
        console.log("\n⛔ Generation stopped.");
      } else {
        console.error("\nError:", err.message);
      }
    }

    chat();
  });
}

// ----------------------
// CTRL + C HANDLING
// ----------------------
process.on("SIGINT", () => {
  if (controller) {
    controller.abort();
    controller = null;
  } else {
    rl.close();
  }
});

// ----------------------
// START
// ----------------------
console.log("💬 Ollama CLI Chat (type 'exit' to quit)\n");
chat();

// graceful exit
rl.on("close", () => {
  console.log("Session ended.");
  process.exit(0);
});