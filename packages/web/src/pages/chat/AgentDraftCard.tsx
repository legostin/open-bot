// A new agent being put together with the default agent: the card shows the live draft. The user picks the look and
// the proactivity here, corrects everything else in words, and creates the agent with one button (or by saying so).

import { createContext, useContext, useState } from "react";
import { Link } from "wouter";
import { MessageCircle } from "lucide-react";
import { useStore } from "../../lib/store";
import { errorText } from "../../lib/api";
import { agentPath } from "../../lib/team";
import { session } from "../../state/app";
import { createFromDraft, updateDraft, useAgentDraft } from "../../state/agentDrafts";
import { toast } from "../../state/toast";
import { AgentAvatar } from "../../components/AgentAvatar";
import { Button, Spinner } from "../../components/ui";
import { AvatarPicker, InitiativeChoice } from "../Agents";
import { t } from "../../i18n";

/** Draft id → the message holding its newest card. Older cards of the same draft fold into one line. */
export const LatestDraftCards = createContext<ReadonlyMap<string, string>>(new Map());

export function AgentDraftCard({ draftId, messageId }: { draftId: string; messageId: string }) {
  const d = useAgentDraft(draftId);
  const latest = useContext(LatestDraftCards).get(draftId);
  const s = useStore(session);
  const [creating, setCreating] = useState(false);

  if (d === undefined)
    return (
      <div className="flex py-2">
        <Spinner size={16} />
      </div>
    );
  if (d === "missing") return <div className="text-sm text-muted">{t("agentDraft.missing")}</div>;

  const superseded = latest !== undefined && latest !== messageId;
  const created = d.status === "created";
  if (created || superseded)
    return (
      <div className="flex w-full max-w-xl items-center gap-3 rounded-[22px] border border-hairline bg-surface px-3.5 py-3 shadow-card">
        <AgentAvatar avatar={d.avatar} name={d.name} size={36} />
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-semibold">{superseded ? d.name : t("agentDraft.created", { name: d.name })}</div>
          <div className="truncate text-xs text-muted">{superseded ? t("agentDraft.superseded") : t("agentDraft.createdHint")}</div>
        </div>
        {created && !superseded && d.agentId && (
          <Link
            href={agentPath(d.agentId, s?.defaultAgent)}
            className="candy press inline-flex shrink-0 items-center gap-1.5 rounded-full px-3.5 py-1.5 text-sm font-semibold"
          >
            <MessageCircle className="size-4" />
            {t("agentDraft.open")}
          </Link>
        )}
      </div>
    );

  const change = (patch: Parameters<typeof updateDraft>[1]) => updateDraft(d.id, patch).catch((e) => toast(errorText(e), "error"));
  const create = async () => {
    setCreating(true);
    try {
      await createFromDraft(d.id);
    } catch (e) {
      toast(errorText(e), "error");
    } finally {
      setCreating(false);
    }
  };

  return (
    <div className="w-full max-w-xl rounded-[22px] border border-hairline bg-surface p-4 shadow-card">
      <div className="mb-3 text-xs font-medium text-muted">{t("agentDraft.title")}</div>
      <div className="flex items-start gap-3">
        <AgentAvatar avatar={d.avatar} name={d.name} size={56} />
        <div className="min-w-0 flex-1">
          <div className="text-lg leading-tight font-semibold break-words">{d.name}</div>
          <div className="mt-1 text-sm leading-relaxed text-muted">{d.description || t("agentDraft.noDescription")}</div>
        </div>
      </div>
      <div className="mt-4 border-t border-border pt-4">
        <AvatarPicker preview={false} value={d.avatar} name={d.name} onChange={(avatar) => void change({ avatar })} />
      </div>
      <div className="mt-4">
        <div className="mb-2 text-sm font-medium">{t("agentDraft.initiative")}</div>
        <InitiativeChoice value={d.initiative} onChange={(initiative) => void change({ initiative })} />
        {d.initiative === undefined && <div className="mt-1.5 text-xs text-muted">{t("agentDraft.initiativeUnset")}</div>}
      </div>
      <div className="mt-4 flex flex-wrap items-center justify-between gap-3 border-t border-border pt-3">
        <span className="min-w-0 flex-1 text-xs text-muted">{t("agentDraft.correctHint")}</span>
        <Button variant="primary" loading={creating} onClick={() => void create()}>
          {t("agentDraft.create")}
        </Button>
      </div>
    </div>
  );
}
