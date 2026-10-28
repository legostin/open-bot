// A group chat's header (its members, name and settings) and the line under the messages saying who is answering
// and who is next.

import { useEffect, useState } from "react";
import type { Conversation } from "@owlbot/shared";
import { useStore } from "../../lib/store";
import { agents, ensureAgents, ensureGroups, groups, useSelector } from "../../state/app";
import { AgentAvatar, AvatarPair, AvatarStack } from "../../components/AgentAvatar";
import { t } from "../../i18n";
import { GroupDialog } from "./GroupDialog";

function useMembers(ids: string[]) {
  const list = useStore(agents);
  useEffect(() => ensureAgents(), []);
  return ids.map((id) => list?.find((a) => a.id === id) ?? { id, name: id, avatar: undefined });
}

export function GroupHeader({ conv }: { conv: Conversation }) {
  const [editing, setEditing] = useState(false);
  const members = useMembers(conv.members ?? [conv.agentId]);
  const names = members.map((m) => m.name).join(", ");
  return (
    <div className="flex min-w-0 items-center">
      {/* The whole header opens the group's settings: no button of its own for that. */}
      <button
        type="button"
        onClick={() => setEditing(true)}
        title={`${t("group.settings")} · ${t("group.memberCount", { n: members.length })}`}
        className="press flex min-w-0 items-center gap-2.5 rounded-full py-1 pr-3 pl-1 text-left hover:bg-surface-2"
      >
        {/* Phones keep the room for the name: two members, one behind the other. */}
        <AvatarPair agents={members} size={30} className="sm:hidden" ring="bg-bg ring-bg" />
        <span className="hidden sm:flex">
          <AvatarStack agents={members} size={26} max={4} ring="bg-bg ring-bg" />
        </span>
        <span className="min-w-0">
          <span className="block truncate text-[14.5px] leading-tight font-semibold">{conv.title}</span>
          <span className="block truncate text-[11.5px] leading-tight text-muted">{names}</span>
        </span>
      </button>
      <GroupDialog open={editing} onClose={() => setEditing(false)} group={conv} />
    </div>
  );
}

/** While members answer: who has the floor now and who follows. */
export function GroupFloor({ conversationId }: { conversationId: string }) {
  useEffect(() => ensureGroups(), []);
  const g = useSelector(groups, (list) => list?.find((x) => x.conversationId === conversationId));
  const members = useMembers(g?.running ? g.speaking : []);
  if (!g?.running || !members.length) return null;
  const [now, ...next] = members;
  return (
    <div key={now.id} className="animate-in flex items-center gap-2 pl-0.5 text-xs text-muted" role="status" aria-live="polite">
      <AgentAvatar avatar={now.avatar} id={now.id} name={now.name} size={20} running />
      <span className="min-w-0 truncate">
        <span className="font-medium text-fg">{t("group.speaking", { name: now.name })}</span>
        {next.length > 0 && <span> · {t("group.next", { names: next.map((m) => m.name).join(", ") })}</span>}
      </span>
    </div>
  );
}
