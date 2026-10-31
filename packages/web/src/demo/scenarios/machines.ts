// Machines: Bit fixes a failing test on the person's MacBook through the Claude Code subscription, pushes after the
// person's yes, and when that subscription hits its limit carries on with Codex on the same computer.

import type { Chapter } from "./types";

const TOOL = { command: "bash", reading: "read", editing: "edit" } as const;

export const machines: Chapter = {
  id: "machines",
  agent: "bit",
  async play({ d, h, c }) {
    const t = c.chapters.machines;
    await d.open("bit");
    await d.wait(500);
    await d.say(t.ask);

    const fix = h.reply("bit", { machine: "macbook" });
    await fix.think(600);
    for (const s of t.steps) await fix.tool(TOOL[s.step], { detail: s.detail }, "…", s.step === "command" ? 1300 : 900, s.step, s.detail);
    await fix.write(t.fixed);
    fix.push({ type: "choices", options: [...t.choices] });
    fix.done();
    await d.wait(1300);
    await d.choose(t.choices[0]);

    const push = h.reply("bit", { machine: "macbook" });
    await push.think(400);
    const ap = await push.approval({
      tool: "machine_exec",
      input: { command: t.pushCommand },
      summary: t.pushReason,
      ask: { kind: "command", detail: t.pushCommand, host: "github.com", reason: t.pushReason },
    });
    await d.decide(ap.id, "approve", 1500);
    await push.tool("bash", { command: t.pushCommand }, "ok", 1000, "command", t.pushCommand);
    // The subscription runs out: the brains list shows the limit, and the next turn goes to Codex.
    const until = new Date();
    until.setHours(18, 0, 0, 0);
    if (until.getTime() < Date.now()) until.setDate(until.getDate() + 1);
    const claude = h.hub.world.brains.find((b) => b.ref === "claude-code@macbook");
    if (claude) claude.limitedUntil = until.toISOString();
    h.hub.emit({ type: "brains.updated", data: {} });
    await push.write(t.limit);
    push.done();
    await d.wait(1300);

    await d.say(t.prAsk);
    const pr = h.reply("bit", { machine: "macbook", brain: "codex" });
    await pr.think(500);
    for (const s of t.prSteps) await pr.tool(TOOL[s.step], { detail: s.detail }, "…", 1000, s.step, s.detail);
    await pr.write(t.prDone);
    pr.done();
    await d.wait(1500);
  },
};
