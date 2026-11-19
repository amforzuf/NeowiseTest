import assert from "node:assert/strict";
import { once } from "node:events";
import { after, before, describe, it } from "node:test";
import { createApp } from "./server.mjs";

const manualReview = { status: "manual_review", topic: null, draft: null };

async function startApp(options) {
  const server = createApp(options);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    close: () => new Promise((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    }),
  };
}

async function post(app, body) {
  const response = await fetch(`${app.url}/api/triage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body,
    signal: AbortSignal.timeout(2_000),
  });
  assert.match(response.headers.get("content-type"), /application\/json/);
  return { status: response.status, body: await response.json() };
}

describe("POST /api/triage", () => {
  let app;
  before(async () => { app = await startApp(); });
  after(async () => { await app?.close(); });

  for (const [name, body] of [
    ["empty body", ""],
    ["broken JSON", '{"text":'],
    ["missing text", "{}"],
    ["null", "null"],
    ["array", "[]"],
    ["string", '"hello"'],
    ["empty text", '{"text":""}'],
    ["whitespace", JSON.stringify({ text: " \n\t " })],
    ["null text", '{"text":null}'],
    ["number", '{"text":42}'],
    ["boolean", '{"text":false}'],
    ["object", '{"text":{}}'],
    ["text array", '{"text":[]}'],
  ]) {
    it(`rejects ${name}`, async () => {
      assert.deepEqual(await post(app, body), {
        status: 400,
        body: { status: "invalid_input" },
      });
    });
  }

  for (const [text, topic] of [
    ["Когда доставка?", "delivery"],
    ["  Какая стоимость?  ", "pricing"],
    ["Добрый день", "other"],
  ]) {
    it(`returns a ready draft for ${topic}`, async () => {
      assert.deepEqual(await post(app, JSON.stringify({ text })), {
        status: 200,
        body: { status: "ready", topic, draft: "Спасибо за обращение. Уточним детали заявки." },
      });
    });
  }

  for (const marker of ["[timeout]", "[error]", "[bad-json]", "[bad-topic]", "[empty-draft]"]) {
    it(`falls back to manual review for ${marker}`, async () => {
      assert.deepEqual(await post(app, JSON.stringify({ text: marker })), {
        status: 200,
        body: manualReview,
      });
    });
  }

  it("returns no previous draft on failure and recovers on the next request", async () => {
    const send = (text) => post(app, JSON.stringify({ text }));
    assert.equal((await send("доставка")).body.status, "ready");
    assert.deepEqual((await send("[error]")).body, manualReview);
    assert.equal((await send("стоимость")).body.topic, "pricing");
  });
});

describe("model boundary", () => {
  it("does not call the model for invalid input", async (t) => {
    let calls = 0;
    const app = await startApp({ classifyMessage: () => { calls++; } });
    t.after(app.close);
    await post(app, '{"text":"  "}');
    await post(app, "{");
    assert.equal(calls, 0);
  });

  it("limits waiting to 300 ms even if the model ignores cancellation", async (t) => {
    let signal;
    const app = await startApp({
      classifyMessage: (_text, options) => {
        signal = options.signal;
        return new Promise(() => {});
      },
    });
    t.after(app.close);
    const started = performance.now();
    const response = await post(app, '{"text":"hello"}');
    const elapsed = performance.now() - started;
    assert.deepEqual(response, { status: 200, body: manualReview });
    assert.equal(signal.aborted, true);
    assert.ok(elapsed >= 250 && elapsed < 1_000, `Unexpected wait: ${elapsed} ms`);
  });

  for (const result of [
    null, [], "hello", 42, true, {},
    { topic: "other" },
    { topic: "refund", draft: "Hello" },
    { topic: ["other"], draft: "Hello" },
    { topic: "other", draft: null },
    { topic: "other", draft: 42 },
    { topic: "other", draft: " \t\n " },
  ]) {
    it(`rejects model output ${JSON.stringify(result)}`, async (t) => {
      const app = await startApp({ classifyMessage: async () => JSON.stringify(result) });
      t.after(app.close);
      assert.deepEqual(await post(app, '{"text":"hello"}'), {
        status: 200,
        body: manualReview,
      });
    });
  }

  it("returns only validated fields, ignoring a status supplied by the model", async (t) => {
    const app = await startApp({
      classifyMessage: async () => JSON.stringify({
        status: "manual_review", topic: "other", draft: "  Hello  ", extra: "ignored",
      }),
    });
    t.after(app.close);
    assert.deepEqual(await post(app, '{"text":"hello"}'), {
      status: 200,
      body: { status: "ready", topic: "other", draft: "Hello" },
    });
  });
});
