// The team: three requests in one message. Pio hands the comparison to Leo as a task (its line shows Leo's live
// step), sets the reminder, looks up the trains itself, and Leo's result comes back as a reply to the request.

import type { Chapter } from "./types";

export const team: Chapter = {
  id: "team",
  agent: "pio",
  async play({ d, h, c }) {
    const t = c.chapters.team;
    await d.open("pio");
    await d.wait(500);
    const asked = await d.say(t.ask);

    const plan = h.reply("pio");
    await plan.think(700);
    await plan.tool("task_delegate", { agent: "leo", goal: t.laptopsGoal }, "started", 500, "tool", "task_delegate");
    const task = h.task({ agentId: "leo", title: t.laptopsTask, goal: t.laptopsGoal, status: "running", parentConversationId: plan.conversationId });
    plan.push({ type: "task", taskId: task.id });
    await plan.tool("trigger_create", { kind: "once", at: "19:00" }, "created", 400, "tool", "trigger_create");
    await plan.write(t.reply);
    plan.done();

    const leo = async () => {
      const work = h.reply("leo", { conversationId: task.conversationId, taskId: task.id, brain: "codex" });
      for (const what of t.reviewing) await work.tool("web_fetch", { what }, "…", 1500, "reading", what);
      await work.write(t.laptopsResult);
      work.done();
      h.updateTask(task.id, { status: "done", result: t.laptopsResult });
    };
    const trains = async () => {
      await d.wait(900);
      const r = h.reply("pio");
      await r.think(400);
      for (const site of t.trainsSites) await r.tool("browser_open", { site }, "ok", 1000, "web", site);
      await r.write(t.trains);
      r.push({ type: "choices", options: [t.pick] });
      r.done();
    };
    await Promise.all([leo(), trains()]);

    await d.wait(600);
    const back = h.reply("pio");
    back.push({ type: "reply_to", messageId: asked.id, text: t.ask });
    await back.think(300);
    await back.write(t.laptopsResult);
    back.done();
    await d.wait(1800);
  },
};
