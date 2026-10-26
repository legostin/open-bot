// The value behind "@owlbot/ui" for UI plugins (window.__OWLBOT_SHARED__.ui).

import { useEffect, useRef } from "react";
import type { OwlbotUIRuntime } from "@owlbot/ui";
import type { UiEvent } from "@owlbot/shared";
import { Badge, Button, Card, EmptyState, Spinner } from "../components/ui";
import { Markdown } from "../components/markdown";
import { api } from "../lib/api";
import { native } from "../lib/native";
import { useStore } from "../lib/store";
import { ensureTasks, hubEvents, tasks } from "../state/app";
import { locale } from "../i18n";

const NO_TASKS: never[] = [];

function useTasks() {
  useEffect(() => ensureTasks(), []);
  return useStore(tasks) ?? NO_TASKS;
}

function useHubEvent(cb: (e: UiEvent) => void, deps: unknown[] = []) {
  const ref = useRef(cb);
  ref.current = cb;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => hubEvents.on((e) => ref.current(e)), deps);
}

export const uiRuntime: OwlbotUIRuntime = {
  definePluginUI: (activate) => ({ activate }),
  Button,
  Card,
  Badge,
  EmptyState,
  Spinner,
  Markdown: ({ text }) => <Markdown text={text} />,
  useTasks,
  useHubEvent,
  api,
  // A getter: the shim (/shared/owlbot-ui.js) reads it when the first plugin is imported, after the hub
  // language has been adopted, while this object is built before that.
  get locale() {
    return locale;
  },
  // The iOS app's bridge (undefined in a browser): fixed for the page's lifetime.
  native,
};
