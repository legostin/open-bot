// The value behind "@openbot/ui" for UI plugins (window.__OPENBOT_SHARED__.ui).

import { useEffect, useRef } from "react";
import type { OpenBotUIRuntime } from "@openbot/ui";
import type { UiEvent } from "@openbot/shared";
import { Badge, Button, Card, EmptyState, Spinner } from "../components/ui";
import { Markdown } from "../components/markdown";
import { api } from "../lib/api";
import { useStore } from "../lib/store";
import { ensureTasks, hubEvents, tasks } from "../state/app";

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

export const uiRuntime: OpenBotUIRuntime = {
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
};
