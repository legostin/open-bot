// A plugin with catalog entries for the tests: "chat" from its manifest, "notes" added by a tool; an entry signs in
// through the plugin (a link, then connected a moment later, with a tool of its own) and out again.
import type { PluginContext } from "@owlbot/plugin-sdk";
import type { CatalogEntryState } from "@owlbot/shared";

export default {
  async activate(ctx: PluginContext) {
    const connected = new Set<string>();
    const broken = new Set<string>();
    let added = (await ctx.storage.get<boolean>("added")) ?? false;
    const hasKey = async () => {
      try {
        await ctx.vault.get("outside_key");
        return true;
      } catch {
        return false;
      }
    };
    const report = async () => {
      const key = await hasKey();
      const state = (id: string): Pick<CatalogEntryState, "status" | "connect" | "detail" | "account"> =>
        !key
          ? { status: "needs-setup", connect: "setup" }
          : broken.has(id)
            ? { status: "broken", connect: "signin", detail: "%detail.revoked%" }
            : connected.has(id)
              ? { status: "connected", connect: "signin", account: `${id}@outside` }
              : { status: "needs-setup", connect: "signin" };
      const entries: CatalogEntryState[] = [{ id: "chat", ...state("chat") }];
      if (added) entries.push({ id: "notes", name: "Notes", summary: "%entry.added%", category: "work", icon: "notebook", ...state("notes") });
      // Junk the core drops: a bad id, a duplicate, an unknown status.
      entries.push({ id: "Bad Id", status: "connected", connect: "signin" }, { id: "chat", status: "connected", connect: "signin" }, { id: "odd", status: "weird" as any, connect: "signin" });
      ctx.catalog.update(entries);
    };
    ctx.events.on("vault.updated", () => void report());
    ctx.tools.register({
      name: "add_notes",
      description: "Adds the Notes app",
      effect: "local-write",
      inputSchema: { type: "object", properties: {} },
      handler: async () => {
        added = true;
        await ctx.storage.set("added", true);
        await report();
        return "Notes added as outside:notes.";
      },
    });
    ctx.tools.register({
      name: "break",
      description: "Breaks an entry's sign-in",
      effect: "local-write",
      inputSchema: { type: "object", properties: { id: { type: "string" } } },
      handler: async (input) => {
        broken.add(String(input.id));
        await report();
        return "broken";
      },
    });
    ctx.catalog.onSignIn(async (entryId) => {
      setTimeout(() => {
        connected.add(entryId);
        broken.delete(entryId);
        ctx.tools.register({ name: `${entryId}_read`, description: `Reads ${entryId}`, effect: "read", inputSchema: { type: "object", properties: {} }, handler: async () => "read" });
        void report();
      }, 100);
      return { url: `https://outside.example/link/${entryId}` };
    });
    ctx.catalog.onSignOut(async (entryId) => {
      connected.delete(entryId);
      broken.delete(entryId);
      ctx.tools.unregister(`${entryId}_read`);
      await report();
    });
    await report();
  },
};
