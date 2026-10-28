// The sidebar's tabs: the team (every agent with its one long-lived dialog), the group chats and the channels. A row
// shows who said what last, whether someone is working right now and how much is unread; "Add agent" opens the
// new-agent form, "New group" the form for a chat with several agents, "New channel" the form for a channel.

import { useEffect, useMemo, useState } from "react";
import { Link } from "wouter";
import { Plus, UsersRound } from "lucide-react";
import type { AgentDef, GroupChat, TeamMember } from "@owlbot/shared";
import { useStore } from "../../lib/store";
import { shortTime } from "../../lib/format";
import { agentPath, groupOrder, groupPath, teamOrder } from "../../lib/team";
import { agents, ensureAgents, ensureGroups, ensureTeam, groups, session, team } from "../../state/app";
import { ensureFeeds, feeds, unreadPosts } from "../../state/feeds";
import { addAgent } from "../../state/panel";
import { setSidebarTab, sidebarTab, type SidebarTab } from "../../state/prefs";
import { AgentAvatar, AvatarPair } from "../../components/AgentAvatar";
import { UnreadBadge } from "../../components/UnreadBadge";
import { cx, Spinner } from "../../components/ui";
import { t } from "../../i18n";
import { GroupDialog } from "./GroupDialog";
import { ChannelList } from "../channels/ChannelList";

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

/** Agents, groups and channels as tabs; the tab follows what is open (a group's chat, a channel), then the user's pick. */
function Tabs({ value, unread }: { value: SidebarTab; unread: Record<SidebarTab, number> }) {
  const tabs: Array<{ id: SidebarTab; label: string }> = [
    { id: "agents", label: t("team.tab.agents") },
    { id: "groups", label: t("team.tab.groups") },
    { id: "channels", label: t("team.tab.channels") },
  ];
  return (
    <div className="mx-3 mb-1 flex rounded-xl bg-surface-2 p-0.5" role="tablist">
      {tabs.map((tab) => (
        <button
          key={tab.id}
          type="button"
          role="tab"
          aria-selected={value === tab.id}
          onClick={() => setSidebarTab(tab.id)}
          className={cx(
            "relative flex min-w-0 flex-1 items-center justify-center rounded-[10px] px-1 py-1.5 text-[13px] font-medium transition",
            value === tab.id ? "bg-surface text-fg shadow-sm" : "text-muted hover:text-fg",
          )}
        >
          <span className="truncate">{tab.label}</span>
          {value !== tab.id && unread[tab.id] > 0 && <span className="absolute top-1 right-1 size-1.5 rounded-full bg-accent" aria-label={t("team.unread", { n: unread[tab.id] })} />}
        </button>
      ))}
    </div>
  );
}

export function TeamList({
  activeAgentId,
  activeConversationId,
  activeFeedId,
  onNavigate,
}: {
  activeAgentId?: string;
  activeConversationId?: string;
  activeFeedId?: string;
  onNavigate?: () => void;
}) {
  const agentList = useStore(agents);
  const members = useStore(team);
  const groupList = useStore(groups);
  const feedList = useStore(feeds);
  const picked = useStore(sidebarTab);
  const s = useStore(session);
  const [creating, setCreating] = useState(false);
  useEffect(() => {
    ensureAgents();
    ensureTeam();
    ensureGroups();
    ensureFeeds();
  }, []);
  const byId = useMemo(() => new Map((agentList ?? []).map((a) => [a.id, a])), [agentList]);
  const groupRows = useMemo(() => groupOrder(groupList ?? []), [groupList]);
  // A group needs two agents: with one there is nobody to invite yet.
  const canGroup = (agentList?.length ?? 0) >= 2;
  const openGroup = !!activeConversationId && groupRows.some((g) => g.conversationId === activeConversationId);
  // Opening a channel or a group (a link, the address bar) shows its tab once; the user's own pick wins after that.
  useEffect(() => {
    if (activeFeedId) setSidebarTab("channels");
    else if (openGroup) setSidebarTab("groups");
  }, [activeFeedId, openGroup]);
  const tab = picked;

  const entries = useMemo(() => {
    const byAgent = new Map((members ?? []).map((m) => [m.agentId, m]));
    return teamOrder(
      (agentList ?? []).map((agent) => ({ agent, member: byAgent.get(agent.id) })),
      s?.defaultAgent,
    );
  }, [agentList, members, s?.defaultAgent]);
  const unread: Record<SidebarTab, number> = {
    agents: (members ?? []).reduce((n, m) => n + (m.unread ?? 0), 0),
    groups: groupRows.reduce((n, g) => n + g.unread, 0),
    channels: unreadPosts(feedList),
  };

  const add = () => {
    addAgent();
    onNavigate?.();
  };

  const addRow = (label: string, icon: React.ReactNode, onClick: () => void) => (
    <button type="button" onClick={onClick} className="flex w-full items-center gap-3 rounded-xl px-2.5 py-2 text-left text-sm font-medium text-accent-text transition hover:bg-surface-2">
      <span className="flex size-9 shrink-0 items-center justify-center rounded-full border border-dashed border-accent/60">{icon}</span>
      {label}
    </button>
  );

  return (
    <div className="flex h-full min-h-0 flex-col">
      <Tabs value={tab} unread={unread} />
      <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-3" role="tabpanel">
        {tab === "agents" && (
          <>
            {!agentList && (
              <div className="flex justify-center py-6">
                <Spinner />
              </div>
            )}
            {entries.map(({ agent, member }) => (
              <MemberRow key={agent.id} agent={agent} member={member} href={agentPath(agent.id, s?.defaultAgent)} active={agent.id === activeAgentId} onNavigate={onNavigate} />
            ))}
            {agentList && addRow(t("team.add"), <Plus className="size-4" />, add)}
          </>
        )}
        {tab === "groups" && (
          <>
            {groupRows.map((g) => (
              <GroupRow key={g.conversationId} group={g} byId={byId} active={g.conversationId === activeConversationId} onNavigate={onNavigate} />
            ))}
            {canGroup ? addRow(t("team.newGroup"), <UsersRound className="size-4" />, () => setCreating(true)) : agentList && <p className="px-3 pt-2 text-xs leading-relaxed text-muted">{t("team.groupsNeedTwo")}</p>}
          </>
        )}
        {tab === "channels" && <ChannelList activeId={activeFeedId} onNavigate={onNavigate} />}
      </div>
      {/* Creating one opens it; the drawer on phones closes with the navigation. */}
      <GroupDialog open={creating} onClose={() => setCreating(false)} />
    </div>
  );
}
