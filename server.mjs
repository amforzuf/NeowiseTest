import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { classify } from "./mock-ai.mjs";

const html = await readFile(new URL("./index.html", import.meta.url));
const topics = new Set(["delivery", "pricing", "other"]);
const modelTimeoutMs = 300;
const manualReview = { status: "manual_review", topic: null, draft: null };

function json(response, status, body) {
  response.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(body));
}

async function triage(text, classifyMessage) {
  const controller = new AbortController();
  let timer;

  try {
    const deadline = new Promise((_, reject) => {
      timer = setTimeout(() => {
        reject(new Error("Model timed out"));
        controller.abort();
      }, modelTimeoutMs);
    });
    const raw = await Promise.race([
      classifyMessage(text, { signal: controller.signal }),
      deadline,
    ]);
    const result = JSON.parse(raw);
    if (
      !result ||
      !topics.has(result.topic) ||
      typeof result.draft !== "string" ||
      !result.draft.trim()
    ) {
      return manualReview;
    }
    return { status: "ready", topic: result.topic, draft: result.draft.trim() };
  } catch {
    return manualReview;
  } finally {
    clearTimeout(timer);
  }
}

async function handleTriage(request, response, classifyMessage) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  let input;
  try {
    input = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    return json(response, 400, { status: "invalid_input" });
  }
  if (typeof input?.text !== "string" || !input.text.trim()) {
    return json(response, 400, { status: "invalid_input" });
  }
  return json(response, 200, await triage(input.text.trim(), classifyMessage));
}

export function createApp({ classifyMessage = classify } = {}) {
  return createServer(async (request, response) => {
    if (request.method === "GET" && request.url === "/") {
      response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      response.end(html);
      return;
    }
    if (request.method !== "POST" || request.url !== "/api/triage") {
      return json(response, 404, { status: "not_found" });
    }
    try {
      await handleTriage(request, response, classifyMessage);
    } catch {
      json(response, 500, { status: "server_error" });
    }
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const server = createApp().listen(Number(process.env.PORT || 3000), "127.0.0.1", () => {
    console.log(`http://127.0.0.1:${server.address().port}`);
  });
}
