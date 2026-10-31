// The browser and teach mode: the person shows Leo how they order water in the agents' browser (pointer, voice,
// a Highlight on the total), Leo retells it and asks what may be done without asking, the skill is saved with that
// one pre-approved click, then Leo orders by itself, and every Friday from then on.

import browserEn from "../../../../../plugins/browser/.piomio-plugin/locales/en.json";
import browserRu from "../../../../../plugins/browser/.piomio-plugin/locales/ru.json";
import { t as ui } from "../../i18n";
import { BrowserSim, type ShopPage } from "../director/browser";
import { domainOf } from "../assets/shop/shop.mjs";
import type { Chapter } from "./types";

const PLUGIN_TEXT: Record<string, Record<string, string>> = { en: browserEn, ru: browserRu };

export const browser: Chapter = {
  id: "browser",
  agent: "leo",
  async play({ d, h, c, clock }) {
    const t = c.chapters.browser;
    const say = (key: string) => PLUGIN_TEXT[c.locale]?.[key] ?? PLUGIN_TEXT.en[key];
    const sim = new BrowserSim(h.hub, clock, c.locale);
    try {
      await sim.load();
      await d.open("leo");
      await d.wait(500);
      await d.say(t.ask);

      const start = h.reply("leo");
      await start.think(500);
      await start.tool("browser_teach", { goal: t.goal }, "the person is showing", 400, "tool", "browser_teach");
      await start.write(t.watching);
      start.done();
      // The live view opens large, with the teach bar: control is the person's.
      sim.startTeach("leo", t.goal);
      await sim.show("home");
      await d.wait(1600);

      const click = async (part: string, next: ShopPage) => {
        await d.pointAt(sim.where(part), part);
        await sim.show(next);
        sim.step();
        await d.wait(700);
      };
      await click("nav-catalogue", "catalogue");
      await d.speak(t.voice[0]);
      await click("item-19", "product");
      await d.pointAt(sim.where("qty"), "the quantity");
      await sim.show("product2");
      sim.step();
      await d.speak(t.voice[1]);
      await click("add", "cart");
      await d.wait(400);
      const total = sim.where("total");
      if (total) await d.highlight(total.box);
      await d.speak(t.voice[2]);
      await click("order", "done");
      await d.wait(600);

      const done = sim.next("teach:done");
      await d.pressText(say("ui.teach.done"));
      await done;
      sim.endTeach();
      await d.wait(500);
      await d.pressIfThere(() => document.querySelector(`button[aria-label="${ui("liveView.collapse")}"]`), "the live view's collapse button");
      await d.wait(500);
      await d.pressIfThere(() => document.querySelector(`button[aria-label="${ui("liveView.minimize")}"]`), "the live view's minimize button");
      await d.wait(500);

      const learn = h.reply("leo");
      await learn.think(900);
      await learn.write(t.retell);
      learn.push({ type: "choices", options: [...t.choices] });
      learn.done();
      await d.wait(1600);
      await d.choose(t.choices[0]);

      const save = h.reply("leo");
      await save.think(500);
      const ap = await save.approval({
        tool: "hub_skill_save",
        input: { name: t.goal, allow: [{ site: domainOf(c.locale), label: "order" }] },
        summary: t.skillSummary,
        effect: "local-write",
      });
      await d.decide(ap.id, "approve", 1700);
      await save.write(t.saved);
      save.done();
      await d.wait(1300);

      await d.say(t.orderAsk);
      const run = h.reply("leo");
      await run.think(400);
      await run.write(t.ordering);
      sim.drive("leo", "browser_open");
      for (const [page, tool] of [
        ["home", "browser_open"],
        ["catalogue", "browser_click"],
        ["product", "browser_click"],
        ["product2", "browser_type"],
        ["cart", "browser_click"],
        ["done", "browser_submit"],
      ] as const) {
        sim.drive("leo", tool);
        await run.tool(tool, { site: domainOf(c.locale) }, "ok", 900, "web", domainOf(c.locale));
        await sim.show(page);
      }
      sim.drive(null, null);
      await d.wait(900);
      await d.pressIfThere(() => document.querySelector(`button[aria-label="${ui("liveView.minimize")}"]`), "the live view's minimize button");
      await run.write(`\n\n${t.ordered}`);
      run.done();
      await d.wait(1300);

      await d.say(t.scheduleAsk);
      const sched = h.reply("leo");
      await sched.think(400);
      await sched.tool("trigger_create", { kind: "schedule", cron: "0 9 * * 5", skill: t.goal }, "created", 600, "tool", "trigger_create");
      await sched.write(t.scheduled);
      sched.done();
      await d.wait(1600);
    } finally {
      sim.dispose();
    }
  },
};
