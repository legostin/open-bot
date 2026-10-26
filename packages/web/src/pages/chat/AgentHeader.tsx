// The header of a dialog: the agent you are talking to (avatar, name, description), the brain it thinks with
// and the way to its settings.

import { useEffect } from "react";
import { SlidersHorizontal } from "lucide-react";
import { useStore } from "../../lib/store";
import { agents, ensureAgents } from "../../state/app";
import { editAgent } from "../../state/panel";
import { AgentAvatar } from "../../components/AgentAvatar";
import { IconButton } from "../../components/ui";
import { BrainPicker } from "./BrainPicker";
import { t } from "../../i18n";

export function AgentHeader({ agentId, settings = true }: { agentId?: string; settings?: boolean }) {
  const list = useStore(agents);
  useEffect(() => ensureAgents(), []);
  const agent = list?.find((a) => a.id === agentId);
  const name = agent?.name ?? agentId ?? t("message.assistant");
  const canEdit = !!agent && settings;
  return (
    <div className="flex min-w-0 items-center gap-0.5">
      <button
        type="button"
        disabled={!canEdit}
        onClick={() => agent && editAgent(agent.id)}
        title={canEdit ? t("agent.settings") : undefined}
        className="flex min-w-10 items-center gap-2.5 rounded-xl py-1 pr-2 pl-1 text-left transition enabled:hover:bg-surface-2"
      >
        <AgentAvatar avatar={agent?.avatar} id={agentId} name={name} size={32} />
        <span className="min-w-0">
          <span className="block truncate text-[15px] leading-tight font-semibold">{name}</span>
          {agent?.description && <span className="block truncate text-xs leading-tight text-muted">{agent.description}</span>}
        </span>
      </button>
      {agent && settings && <BrainPicker agent={agent} />}
      {agent && settings && (
        <IconButton label={t("agent.settings")} onClick={() => editAgent(agent.id)} className="size-8 shrink-0">
          <SlidersHorizontal className="size-4" />
        </IconButton>
      )}
    </div>
  );
}
