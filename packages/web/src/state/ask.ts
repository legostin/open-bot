// Things are made and set up in the chat (CLAUDE.md, "Interface"): "New channel" or a channel's settings open the
// right agent's dialog with the person's request in their words, and the agent takes it from there with buttons.
import { agentPath } from "../lib/team";
import { refreshTeam, sendMessage, session, team } from "./app";

/** Opens `agentId`'s dialog (the default agent's without one) and sends `text` there as the person. */
export async function askInChat(agentId: string | undefined, text: string, navigate: (path: string) => void): Promise<void> {
  const s = session.get();
  const id = agentId ?? s?.defaultAgent;
  if (!id) return;
  const members = team.get() ?? (await refreshTeam()) ?? [];
  navigate(agentPath(id, s?.defaultAgent));
  const member = members.find((m) => m.agentId === id);
  if (member) await sendMessage(member.conversationId, text);
}
