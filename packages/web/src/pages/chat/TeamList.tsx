// The sidebar is the user's team: every agent with its one long-lived dialog, then the group chats. A row shows who
// said what last, whether someone is working right now and how much is unread; "Add agent" opens the new-agent form,
// "New group" the form for a chat with several agents.

import { useEffect, useMemo, useState } from "react";
import { Link } from "wouter";
import { Plus, UsersRound } from "lucide-react";
import type { AgentDef, GroupChat, TeamMember } from "@owlbot/shared";
import { useStore } from "../../lib/store";
import { shortTime } from "../../lib/format";
import { agentPath, groupOrder, groupPath, teamOrder } from "../../lib/team";
import { agents, ensureAgents, ensureGroups, ensureTeam, groups, session, team } from "../../state/app";
import { addAgent } from "../../state/panel";
import { AgentAvatar, AvatarPair } from "../../components/AgentAvatar";
import { cx, IconButton, Spinner } from "../../components/ui";
import { t } from "../../i18n";
import { GroupDialog } from "./GroupDialog";

function MemberRow({ agent, member, href, active, onNavigate }: { agent: AgentDef; member?: TeamMember; href: string; active: boolean; onNavigate?: () => void }) {
  const unread = member?.unread ?? 0;
  const running = !!member?.running;
  const last = member?.lastMessage;
  const preview = last ? (last.role === "user" ? t("team.you", { text: last.text }) : last.text) : agent.description || t("team.noMessages");
  return (
    <Link
      href={href}
      onClick={onNavigate}
      aria-current={active ? "page" : undefined}
      className={cx("flex items-center gap-3 rounded-xl px-2.5 py-2 transition", active ? "bg-accent-soft" : "hover:bg-surface-2")}
    >
      <span className="relative shrink-0">
        <AgentAvatar avatar={agent.avatar} id={agent.id} name={agent.name} size={36} />
        {running && (
          <span className="absolute -right-0.5 -bottom-0.5 flex size-3.5 items-center justify-center rounded-full bg-surface">
            <span className="size-2 animate-pulse rounded-full bg-accent" />
          </span>
        )}
      </span>
      <span className="min-w-0 flex-1">
        <span className="flex items-baseline gap-2">
          <span className={cx("min-w-0 flex-1 truncate text-sm", unread ? "font-semibold" : "font-medium", active && "text-accent-text")}>{agent.name}</span>
          {last && <span className="shrink-0 text-[11px] text-muted">{shortTime(last.createdAt)}</span>}
        </span>
        <span className="mt-0.5 flex items-center gap-2">
          {running ? (
            <span className="min-w-0 flex-1 truncate text-xs text-accent-text">{t("team.working")}</span>
          ) : (
            <span className={cx("min-w-0 flex-1 truncate text-xs", unread ? "text-fg" : "text-muted")}>{preview}</span>
          )}
          {unread > 0 && <UnreadBadge n={unread} />}
        </span>
      </span>
    </Link>
  );
}

/** The small count of unread messages on a row. */
function UnreadBadge({ n }: { n: number }) {
  return (
    <span
      className="flex h-[18px] min-w-[18px] shrink-0 items-center justify-center rounded-full bg-accent px-1 text-[10px] font-semibold text-accent-fg"
      title={t("team.unread", { n })}
      aria-label={t("team.unread", { n })}
    >
      {n > 99 ? "99+" : n}
    </span>
  );
}

function GroupRow({ group, byId, active, onNavigate }: { group: GroupChat; byId: Map<string, AgentDef>; active: boolean; onNavigate?: () => void }) {
  const members = group.members.map((id) => byId.get(id) ?? { id, name: id, avatar: undefined });
  const name = (id: string | undefined) => (id ? (byId.get(id)?.name ?? id) : "");
  const last = group.lastMessage;
  const speaker = group.running ? group.speaking[0] : undefined;
  const preview = last
    ? last.role === "user"
      ? t("team.you", { text: last.text })
      : last.agentId
        ? t("team.said", { name: name(last.agentId), text: last.text })
        : last.text
    : members.map((m) => m.name).join(", ");
  return (
    <Link
      href={groupPath(group.conversationId)}
      onClick={onNavigate}
      aria-current={active ? "page" : undefined}
      className={cx("group flex items-center gap-3 rounded-xl px-2.5 py-2 transition", active ? "bg-accent-soft" : "hover:bg-surface-2")}
    >
      <span className="relative shrink-0">
        <AvatarPair agents={members} size={36} ring={active ? "bg-accent-soft ring-accent-soft" : "bg-surface ring-surface group-hover:bg-surface-2 group-hover:ring-surface-2"} />
        {group.running && (
          <span className="absolute -right-0.5 -bottom-0.5 flex size-3.5 items-center justify-center rounded-full bg-surface">
            <span className="size-2 animate-pulse rounded-full bg-accent" />
          </span>
        )}
      </span>
      <span className="min-w-0 flex-1">
        <span className="flex items-baseline gap-2">
          <span className={cx("min-w-0 flex-1 truncate text-sm", group.unread ? "font-semibold" : "font-medium", active && "text-accent-text")}>{group.title}</span>
          {last && <span className="shrink-0 text-[11px] text-muted">{shortTime(last.createdAt)}</span>}
        </span>
        <span className="mt-0.5 flex items-center gap-2">
          {group.running ? (
            <span className="min-w-0 flex-1 truncate text-xs text-accent-text">{speaker ? t("group.speaking", { name: name(speaker) }) : t("team.working")}</span>
          ) : (
            <span className={cx("min-w-0 flex-1 truncate text-xs", group.unread ? "text-fg" : "text-muted")}>{preview}</span>
          )}
          {group.unread > 0 && <UnreadBadge n={group.unread} />}
        </span>
      </span>
    </Link>
  );
}

export function TeamList({ activeAgentId, activeConversationId, onNavigate }: { activeAgentId?: string; activeConversationId?: string; onNavigate?: () => void }) {
  const agentList = useStore(agents);
  const members = useStore(team);
  const groupList = useStore(groups);
  const s = useStore(session);
  const [creating, setCreating] = useState(false);
  useEffect(() => {
    ensureAgents();
    ensureTeam();
    ensureGroups();
  }, []);
  const byId = useMemo(() => new Map((agentList ?? []).map((a) => [a.id, a])), [agentList]);
  const groupRows = useMemo(() => groupOrder(groupList ?? []), [groupList]);
  // A group needs two agents: with one there is nobody to invite yet.
  const canGroup = (agentList?.length ?? 0) >= 2;

  const entries = useMemo(() => {
    const byAgent = new Map((members ?? []).map((m) => [m.agentId, m]));
    return teamOrder(
      (agentList ?? []).map((agent) => ({ agent, member: byAgent.get(agent.id) })),
      s?.defaultAgent,
    );
  }, [agentList, members, s?.defaultAgent]);

  const add = () => {
    addAgent();
    onNavigate?.();
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex items-center justify-between py-1 pr-2 pl-5">
        <span className="text-[11px] font-semibold tracking-wide text-muted uppercase">{t("team.title")}</span>
        <IconButton label={t("team.add")} onClick={add} className="size-8">
          <Plus className="size-4" />
        </IconButton>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-3">
        {!agentList && (
          <div className="flex justify-center py-6">
            <Spinner />
          </div>
        )}
        {entries.map(({ agent, member }) => (
          <MemberRow key={agent.id} agent={agent} member={member} href={agentPath(agent.id, s?.defaultAgent)} active={agent.id === activeAgentId} onNavigate={onNavigate} />
        ))}
        {agentList && (
          <button type="button" onClick={add} className="flex w-full items-center gap-3 rounded-xl px-2.5 py-2 text-left text-sm font-medium text-accent-text transition hover:bg-surface-2">
            <span className="flex size-9 shrink-0 items-center justify-center rounded-full border border-dashed border-accent/60">
              <Plus className="size-4" />
            </span>
            {t("team.add")}
          </button>
        )}

        {agentList && (canGroup || groupRows.length > 0) && (
          <section className="mt-3" aria-label={t("team.groups")}>
            <div className="flex items-center justify-between py-1 pr-0 pl-3">
              <span className="text-[11px] font-semibold tracking-wide text-muted uppercase">{t("team.groups")}</span>
              {canGroup && (
                <IconButton label={t("team.newGroup")} onClick={() => setCreating(true)} className="size-8">
                  <Plus className="size-4" />
                </IconButton>
              )}
            </div>
            {groupRows.map((g) => (
              <GroupRow key={g.conversationId} group={g} byId={byId} active={g.conversationId === activeConversationId} onNavigate={onNavigate} />
            ))}
            {canGroup && (
              <button
                type="button"
                onClick={() => setCreating(true)}
                className="flex w-full items-center gap-3 rounded-xl px-2.5 py-2 text-left text-sm font-medium text-accent-text transition hover:bg-surface-2"
              >
                <span className="flex size-9 shrink-0 items-center justify-center rounded-full border border-dashed border-accent/60">
                  <UsersRound className="size-4" />
                </span>
                {t("team.newGroup")}
              </button>
            )}
          </section>
        )}
      </div>
      {/* Creating one opens it; the drawer on phones closes with the navigation. */}
      <GroupDialog open={creating} onClose={() => setCreating(false)} />
    </div>
  );
}
