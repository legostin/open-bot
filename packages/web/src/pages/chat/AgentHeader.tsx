// The header of a dialog: who you are talking to, small. Its face (alive while it works) and name open its settings;
// "working…" shows under the name only while it is so. The brain picker shows only when the agent has no brain that
// answers (then it is what is needed); otherwise brains are in the agent's settings.

import { useEffect } from "react";
import { useStore } from "../../lib/store";
import { agents, ensureAgents, team } from "../../state/app";
import { activeBrain, brains, ensureBrains } from "../../state/brains";
import { editAgent } from "../../state/panel";
import { AgentAvatar } from "../../components/AgentAvatar";
import { cx } from "../../components/ui";
import { BrainPicker } from "./BrainPicker";
import { t } from "../../i18n";

export function AgentHeader({ agentId, settings = true }: { agentId?: string; settings?: boolean }) {
  const list = useStore(agents);
  const members = useStore(team);
  const brainList = useStore(brains);
  useEffect(() => {
    ensureAgents();
    ensureBrains();
  }, []);
  const agent = list?.find((a) => a.id === agentId);
  const running = !!members?.find((m) => m.agentId === agentId)?.running;
  const name = agent?.name ?? agentId ?? t("message.assistant");
  const canEdit = !!agent && settings;
  const noBrain = !!agent && !!brainList && !activeBrain(agent.brains, brainList);
  return (
    <div className="flex min-w-0 items-center gap-1.5">
      <button
        type="button"
        disabled={!canEdit}
        onClick={() => agent && editAgent(agent.id)}
        title={canEdit ? `${t("agent.settings")}${agent?.description ? ` · ${agent.description}` : ""}` : agent?.description}
        className="press flex min-w-0 items-center gap-2 rounded-full py-1 pr-3 pl-1 text-left enabled:hover:bg-surface-2"
      >
        <AgentAvatar avatar={agent?.avatar} id={agentId} name={name} size={28} running={running} />
        <span className="min-w-0">
          <span className="block truncate text-[14.5px] leading-tight font-semibold">{name}</span>
          <span className={cx("block overflow-hidden text-[11.5px] leading-tight text-accent-text transition-all duration-300", running ? "max-h-4 opacity-100" : "max-h-0 opacity-0")}>
            {t("team.working")}
          </span>
        </span>
      </button>
      {agent && settings && noBrain && <BrainPicker agent={agent} />}
    </div>
  );
}
