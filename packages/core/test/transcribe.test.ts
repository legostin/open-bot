import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cleanTranscription, pickEngine, Transcriber, uploadName } from "../src/transcribe.ts";

/** A fake OpenAI-compatible speech-to-text server: answers with what it received, or fails for model "broken". */
function fakeStt(): Promise<{ url: string; server: Server; seen: Array<{ auth?: string; body: string }> }> {
  const seen: Array<{ auth?: string; body: string }> = [];
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const body = Buffer.concat(chunks).toString("latin1");
      seen.push({ auth: req.headers.authorization, body });
      res.setHeader("content-type", "application/json");
      if (req.url !== "/v1/audio/transcriptions") return res.writeHead(404).end("{}");
      if (body.includes("broken")) return res.writeHead(401).end(JSON.stringify({ error: { message: "Invalid API key" } }));
      const name = /filename="([^"]+)"/.exec(body)?.[1];
      res.end(JSON.stringify({ text: ` heard ${name} ` }));
    });
  });
  return new Promise((r) => server.listen(0, "127.0.0.1", () => r({ url: `http://127.0.0.1:${(server.address() as any).port}/v1`, server, seen })));
}

describe("speech to text", () => {
  let stt: Awaited<ReturnType<typeof fakeStt>>;
  let dir: string;
  beforeAll(async () => {
    stt = await fakeStt();
    dir = mkdtempSync(join(tmpdir(), "owl-stt-"));
  });
  afterAll(() => stt.server.close());

  it("picks OpenAI, then Groq, by the keys in the vault; or what the user chose", () => {
    const has = (ids: string[]) => (id: string) => ids.includes(id);
    expect(pickEngine({ provider: "auto" }, has([]))).toBeUndefined();
    expect(pickEngine({ provider: "auto" }, has(["groq_api_key"]))).toEqual({ label: "Groq", baseUrl: "https://api.groq.com/openai/v1", model: "whisper-large-v3-turbo", keyRef: "vault://groq_api_key" });
    expect(pickEngine({ provider: "auto" }, has(["groq_api_key", "openai_api_key"]))?.label).toBe("OpenAI");
    expect(pickEngine({ provider: "groq", model: "whisper-large-v3" }, has(["groq_api_key", "openai_api_key"]))).toMatchObject({ label: "Groq", model: "whisper-large-v3" });
    expect(pickEngine({ provider: "openai" }, has(["groq_api_key"]))).toBeUndefined();
    expect(pickEngine({ provider: "off" }, has(["openai_api_key"]))).toBeUndefined();
    expect(pickEngine({ provider: "custom", baseUrl: "http://127.0.0.1:8000/v1", model: "small" }, has([]))).toEqual({ label: "127.0.0.1:8000", baseUrl: "http://127.0.0.1:8000/v1", model: "small" });
  });

  it("checks the settings the user gives", () => {
    expect(cleanTranscription({ provider: "groq", model: " whisper-large-v3 " })).toEqual({ provider: "groq", model: "whisper-large-v3" });
    expect(cleanTranscription({ provider: "loud" })).toMatch(/must be one of/);
    expect(cleanTranscription({ provider: "custom", baseUrl: "http://x/v1" })).toMatch(/needs baseUrl and model/);
    expect(cleanTranscription({ provider: "custom", baseUrl: "ftp://x", model: "m" })).toMatch(/http\(s\)/);
    expect(cleanTranscription({ provider: "custom", baseUrl: "http://x/v1", model: "m", keyRef: "sk-123" })).toMatch(/vault:\/\//);
  });

  it("names the upload with an extension the services accept", () => {
    expect(uploadName("/w/voice-20261027-091500.ogg", "audio/ogg")).toBe("voice-20261027-091500.ogg");
    expect(uploadName("/w/file_7.oga", "audio/ogg")).toBe("audio.ogg");
    expect(uploadName("/w/memo", "audio/x-m4a")).toBe("audio.m4a");
    expect(uploadName("/w/x.opus")).toBe("audio.ogg");
  });

  it("sends the audio with the key and returns the words; explains failures", async () => {
    const file = join(dir, "voice.oga");
    writeFileSync(file, "OggS fake");
    const t = (model: string, keyRef?: string) =>
      new Transcriber({
        settings: () => ({ provider: "custom", baseUrl: stt.url, model, ...(keyRef ? { keyRef } : {}) }),
        hasSecret: () => true,
        secret: (ref) => (ref === "vault://local_stt" ? "sk-local" : (() => { throw new Error("vault is sealed"); })()),
      });
    expect(await t("small", "vault://local_stt").transcribe(file, "audio/ogg")).toBe("heard audio.ogg");
    expect(stt.seen.at(-1)!.auth).toBe("Bearer sk-local");
    expect(stt.seen.at(-1)!.body).toContain('name="model"\r\n\r\nsmall');
    await expect(t("broken").transcribe(file, "audio/ogg")).rejects.toThrow(/answered 401: Invalid API key/);
    await expect(t("small", "vault://other").transcribe(file)).rejects.toThrow(/key cannot be read \(vault is sealed\)/);
    await expect(t("small").transcribe(join(dir, "missing.ogg"))).rejects.toThrow(/missing/);
    const none = new Transcriber({ settings: () => ({ provider: "auto" }), hasSecret: () => false, secret: () => "" });
    await expect(none.transcribe(file)).rejects.toThrow(/no speech-to-text is set up/);
    const down = new Transcriber({ settings: () => ({ provider: "custom", baseUrl: "http://127.0.0.1:1/v1", model: "m" }), hasSecret: () => true, secret: () => "" });
    await expect(down.transcribe(file)).rejects.toThrow(/127\.0\.0\.1:1 is unreachable/);
  });
});
