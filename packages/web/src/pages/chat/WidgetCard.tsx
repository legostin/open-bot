// A plugin's own card in a reply (a `widget` part): the frame is the chat's, the inside is drawn by the component the
// plugin's UI module registered for the kind (ui.widgets.add). While that module loads the frame waits; without it
// (the plugin was turned off since) the card shows nothing: the agent's words carry the answer.

import type { Message, MessagePart } from "@owlbot/shared";
import { useStore } from "../../lib/store";
import { PluginBoundary } from "../../plugins/boundary";
import { pluginLoad } from "../../plugins/host";
import { pickWidget } from "../../plugins/registry";
import { usePluginRegistry } from "../../plugins/slots";
import { Spinner } from "../../components/ui";

type WidgetPart = Extract<MessagePart, { type: "widget" }>;

export function WidgetCard({ part, message }: { part: WidgetPart; message: Message }) {
  const { widgets } = usePluginRegistry();
  const load = useStore(pluginLoad)[part.plugin];
  const entry = pickWidget(widgets, part.plugin, part.kind);
  if (!entry && load?.status !== "loading") return null;
  const C = entry?.component;
  return (
    <figure className="my-2 max-w-full overflow-hidden rounded-2xl border border-border bg-surface shadow-card sm:max-w-md" data-widget={`${part.plugin}/${part.kind}`}>
      {C ? (
        <PluginBoundary pluginId={part.plugin}>
          <C pluginId={part.plugin} kind={part.kind} data={part.data} message={message} />
        </PluginBoundary>
      ) : (
        <div className="flex h-24 items-center justify-center">
          <Spinner />
        </div>
      )}
    </figure>
  );
}
