// An agent's own profile in its chat (profile_show): the person picks its look and how proactive it is right here,
// saved at once; its name and character change in words, and the card follows.

import { useEffect } from "react";
import type { AgentDef } from "@owlbot/shared";
import { defaultAvatar } from "@owlbot/shared";
import { useStore } from "../../lib/store";
import { api, errorText } from "../../lib/api";
import { agents, ensureAgents, refreshAgents } from "../../state/app";
import { toast } from "../../state/toast";
import { AgentAvatar } from "../../components/AgentAvatar";
import { Spinner } from "../../components/ui";
import { AvatarPicker, InitiativeChoice } from "../Agents";
import { t } from "../../i18n";

export function AgentProfileCard({ agentId }: { agentId: string }) {
  const list = useStore(agents);
  useEffect(() => {
    ensureAgents();
  }, []);
  const agent = list?.find((a) => a.id === agentId);
  if (!list)
    return (
      <div className="flex py-2">
        <Spinner size={16} />
      </div>
    );
  if (!agent) return <div className="text-sm text-muted">{t("agentProfile.missing")}</div>;

  const avatar = agent.avatar ?? defaultAvatar(agent.id);
  const save = (patch: Pick<Partial<AgentDef>, "avatar" | "initiative">) => {
    agents.set((l) => l?.map((a) => (a.id === agent.id ? { ...a, ...patch } : a)) ?? l);
    api.put<AgentDef>(`/api/agents/${encodeURIComponent(agent.id)}`, patch).catch((e) => {
      toast(errorText(e), "error");
      void refreshAgents().catch(() => {});
    });
  };

  return (
    <div className="w-full max-w-xl rounded-[22px] border border-hairline bg-surface p-4 shadow-card">
      <div className="mb-3 text-xs font-medium text-muted">{t("agentProfile.title")}</div>
      <div className="flex items-start gap-3">
        <AgentAvatar avatar={avatar} id={agent.id} name={agent.name} size={56} />
        <div className="min-w-0 flex-1">
          <div className="text-lg leading-tight font-semibold break-words">{agent.name}</div>
          {agent.description && <div className="mt-1 text-sm leading-relaxed text-muted">{agent.description}</div>}
        </div>
      </div>
      <div className="mt-4 border-t border-border pt-4">
        <AvatarPicker preview={false} value={avatar} name={agent.name} id={agent.id} onChange={(next) => save({ avatar: next })} />
      </div>
      <div className="mt-4">
        <div className="mb-2 text-sm font-medium">{t("agentDraft.initiative")}</div>
        <InitiativeChoice value={agent.initiative} onChange={(initiative) => save({ initiative })} />
      </div>
      <div className="mt-4 border-t border-border pt-3 text-xs text-muted">{t("agentProfile.hint")}</div>
    </div>
  );
}
