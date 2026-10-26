// Server-Sent Events parser over a byte stream (handles chunk boundaries, CRLF, multi-line data, comments).

export interface SseEvent {
  event: string;
  data: string;
}

export async function* parseSse(body: AsyncIterable<Uint8Array | string>): AsyncGenerator<SseEvent> {
  const decoder = new TextDecoder();
  let buf = "";
  let event = "";
  let data: string[] = [];

  function* line(raw: string): Generator<SseEvent> {
    const l = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
    if (l === "") {
      if (data.length) yield { event: event || "message", data: data.join("\n") };
      event = "";
      data = [];
      return;
    }
    if (l.startsWith(":")) return;
    const i = l.indexOf(":");
    const field = i === -1 ? l : l.slice(0, i);
    let value = i === -1 ? "" : l.slice(i + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    if (field === "event") event = value;
    else if (field === "data") data.push(value);
  }

  for await (const chunk of body) {
    buf += typeof chunk === "string" ? chunk : decoder.decode(chunk, { stream: true });
    let i: number;
    while ((i = buf.indexOf("\n")) >= 0) {
      const raw = buf.slice(0, i);
      buf = buf.slice(i + 1);
      yield* line(raw);
    }
  }
  buf += decoder.decode();
  if (buf) yield* line(buf);
  yield* line("");
}
