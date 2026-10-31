// Security: a phishing letter with an instruction for the assistant; what would happen if Ada obeyed (the guard asks
// the person, who says no); and a key given through the secret card, of which Ada only ever sees vault://….

import { t as ui } from "../../i18n";
import type { Chapter } from "./types";

export const security: Chapter = {
  id: "security",
  agent: "ada",
  async play({ d, h, c, clock }) {
    const t = c.chapters.security;
    await d.open("ada");
    await d.wait(500);
    await d.say(t.ask);

    const look = h.reply("ada");
    await look.think(500);
    await look.tool("gmail_read", { from: t.letter }, "…", 1200, "reading", t.letter);
    await look.write(t.verdict);
    look.push({ type: "choices", options: [...t.choices] });
    look.done();
    await d.wait(1500);
    await d.choose(t.choices[1]);

    const guard = h.reply("ada");
    await guard.think(500);
    await guard.write(t.tryIntro);
    const ap = await guard.approval({ tool: "gmail_send_email", input: { attachments: 3 }, summary: t.summary, tainted: true });
    await d.decide(ap.id, "deny", 2400);
    await guard.tool("gmail_modify", { spam: true }, "ok", 500, "tool", "gmail");
    await guard.write(t.blocked);
    guard.done();
    await d.wait(1400);

    await d.say(t.keyAsk);
    const key = h.reply("ada");
    await key.think(500);
    await key.write(t.keyIntro);
    const req = h.hub.secretRequest({ vaultId: t.keyVault, title: t.keyTitle, hint: t.keyHint, conversationId: key.conversationId });
    key.push({ type: "secret_request", requestId: req.id, vaultId: req.vaultId, title: req.title, status: "pending" });
    const saved = h.hub.waitSignal(`secret:${req.id}`);
    await d.fill(() => document.querySelector<HTMLInputElement>(`input[placeholder="${ui("secret.placeholder")}"]`), t.keyValue, "the secret field");
    await d.pressText(ui("secret.save"));
    await clock.until(saved);
    await key.write(t.keySaved);
    key.done();
    await d.wait(1500);
  },
};
