// A channel's form: making one is a sentence about what to follow and how often ("New channel" on the Channels tab);
// the same form later changes its name, words, schedule and editor, pauses or deletes it.

import { useEffect, useState } from "react";
import { useLocation } from "wouter";
import type { Feed } from "@owlbot/shared";
import { useStore } from "../../lib/store";
import { errorText } from "../../lib/api";
import { CADENCES, cadenceOf, feedPath, type Cadence } from "../../lib/feeds";
import { agents, ensureAgents, session } from "../../state/app";
import { createFeed, deleteFeed, updateFeed } from "../../state/feeds";
import { toast } from "../../state/toast";
import { Button, Field, Input, Modal, Segmented, Select, Textarea, Toggle } from "../../components/ui";
import { t } from "../../i18n";

const LABELS: Record<Cadence, "channel.cadence.morning" | "channel.cadence.twice" | "channel.cadence.thrice" | "channel.cadence.weekly"> = {
  morning: "channel.cadence.morning",
  twice: "channel.cadence.twice",
  thrice: "channel.cadence.thrice",
  weekly: "channel.cadence.weekly",
};

/** Makes a channel (no `feed`) or edits one. */
export function ChannelDialog({ open, onClose, feed }: { open: boolean; onClose: () => void; feed?: Feed }) {
  const list = useStore(agents);
  const s = useStore(session);
  const [, navigate] = useLocation();
  const [title, setTitle] = useState("");
  const [brief, setBrief] = useState("");
  // "custom": the times an agent set, kept as they are.
  const [cadence, setCadence] = useState<Cadence | "custom">("twice");
  const [agentId, setAgentId] = useState("");
  const [enabled, setEnabled] = useState(true);
  const [busy, setBusy] = useState(false);
  // Deleting asks once more on the same button.
  const [armed, setArmed] = useState(false);
  useEffect(() => ensureAgents(), []);
  useEffect(() => {
    if (!armed) return;
    const id = setTimeout(() => setArmed(false), 4000);
    return () => clearTimeout(id);
  }, [armed]);
  useEffect(() => {
    if (!open) return;
    setTitle(feed?.title ?? "");
    setBrief(feed?.brief ?? "");
    setCadence(feed ? (cadenceOf(feed) ?? "custom") : "twice");
    setAgentId(feed?.agentId ?? s?.defaultAgent ?? "");
    setEnabled(feed?.enabled ?? true);
    setBusy(false);
    setArmed(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, feed?.id]);

  const schedule = cadence === "custom" ? {} : CADENCES[cadence];
  const valid = brief.trim().length > 0 && (!feed || title.trim().length > 0);

  const save = async () => {
    if (!valid || busy) return;
    setBusy(true);
    try {
      if (feed) {
        await updateFeed(feed.id, { title: title.trim(), brief: brief.trim(), agentId, enabled, ...schedule });
        onClose();
      } else {
        const f = await createFeed({ brief: brief.trim(), agentId, ...CADENCES[cadence === "custom" ? "twice" : cadence] });
        onClose();
        navigate(feedPath(f.id));
      }
    } catch (e) {
      toast(errorText(e), "error");
      setBusy(false);
    }
  };

  const remove = async () => {
    if (!feed) return;
    if (!armed) {
      setArmed(true);
      return;
    }
    try {
      await deleteFeed(feed.id);
      onClose();
      navigate("/");
    } catch (e) {
      toast(errorText(e), "error");
    }
  };

  const options = (Object.keys(CADENCES) as Cadence[]).map((c) => ({ value: c as Cadence | "custom", label: t(LABELS[c]) }));
  if (cadence === "custom" && feed) options.push({ value: "custom", label: feed.times.join(", ") });

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={feed ? t("channel.settings") : t("channel.new")}
      footer={
        <>
          {feed && (
            <Button variant={armed ? "danger" : "ghost"} className="mr-auto" onClick={() => void remove()}>
              {armed ? t("channel.deleteConfirm") : t("channel.delete")}
            </Button>
          )}
          <Button variant="ghost" onClick={onClose}>
            {t("common.cancel")}
          </Button>
          <Button variant="primary" onClick={() => void save()} disabled={!valid} loading={busy}>
            {feed ? t("common.save") : t("channel.create")}
          </Button>
        </>
      }
    >
      <form
        className="flex flex-col gap-5"
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        {feed && (
          <Field label={t("channel.name")}>
            <Input value={title} onChange={(e) => setTitle(e.target.value)} maxLength={80} />
          </Field>
        )}
        <Field label={t("channel.about")} hint={feed ? undefined : t("channel.aboutHint")}>
          <Textarea autoFocus={!feed} rows={4} value={brief} onChange={(e) => setBrief(e.target.value)} placeholder={t("channel.aboutPlaceholder")} maxLength={2000} />
        </Field>
        <Field group label={t("channel.when")}>
          <Segmented value={cadence} onChange={setCadence} options={options} />
        </Field>
        <Field label={t("channel.editor")} hint={t("channel.editorHint")}>
          <Select value={agentId} onChange={(e) => setAgentId(e.target.value)}>
            {(list ?? []).map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
              </option>
            ))}
          </Select>
        </Field>
        {feed && <Toggle checked={enabled} onChange={setEnabled} label={t("channel.enabled")} />}
      </form>
    </Modal>
  );
}
