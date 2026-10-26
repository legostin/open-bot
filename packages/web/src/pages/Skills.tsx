// Skills, commands and tools (read-only).

import { useEffect, useMemo, useState } from "react";
import { Search } from "lucide-react";
import { api, errorText } from "../lib/api";
import { hubEvents } from "../state/app";
import { Badge, EmptyState, ErrorNote, Input, Loading, Page, Segmented } from "../components/ui";

interface Skill {
  name: string;
  description: string;
  source: string;
}
interface Command {
  name: string;
  description: string;
  source: string;
}
interface Tool {
  name: string;
  description: string;
  effect: "read" | "local-write" | "external";
  owner: string;
  source: boolean;
}

type Tab = "skills" | "commands" | "tools";

const EFFECT: Record<Tool["effect"], { label: string; tone: "success" | "info" | "warning" }> = {
  read: { label: "чтение", tone: "success" },
  "local-write": { label: "локальная запись", tone: "info" },
  external: { label: "внешнее действие", tone: "warning" },
};

export function SkillsPage() {
  const [tab, setTab] = useState<Tab>("skills");
  const [skills, setSkills] = useState<Skill[] | null>(null);
  const [commands, setCommands] = useState<Command[] | null>(null);
  const [tools, setTools] = useState<Tool[] | null>(null);
  const [error, setError] = useState<string>();
  const [q, setQ] = useState("");

  useEffect(() => {
    const load = () => {
      setError(undefined);
      Promise.all([api.get<Skill[]>("/api/skills"), api.get<Command[]>("/api/commands"), api.get<Tool[]>("/api/tools")]).then(
        ([s, c, t]) => {
          setSkills(s);
          setCommands(c);
          setTools(t);
        },
        (e) => setError(errorText(e)),
      );
    };
    load();
    return hubEvents.on((e) => {
      if (e.type === "plugins.updated") load();
    });
  }, []);

  const query = q.trim().toLowerCase();
  const match = (x: { name: string; description: string }) => !query || x.name.toLowerCase().includes(query) || x.description.toLowerCase().includes(query);
  const items = useMemo(() => {
    const list = tab === "skills" ? skills : tab === "commands" ? commands : tools;
    return (list ?? []).filter(match).sort((a, b) => a.name.localeCompare(b.name));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab, skills, commands, tools, query]);

  return (
    <Page title="Скиллы и команды" subtitle="Скиллы — инструкции, которые агент подгружает по необходимости. Команды — шаблоны «/имя» для чата.">
      <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <Segmented<Tab>
          value={tab}
          onChange={setTab}
          options={[
            { value: "skills", label: `Скиллы ${skills?.length ?? ""}` },
            { value: "commands", label: `Команды ${commands?.length ?? ""}` },
            { value: "tools", label: `Инструменты ${tools?.length ?? ""}` },
          ]}
        />
        <div className="relative sm:w-64">
          <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted" />
          <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Поиск" className="pl-9" aria-label="Поиск" />
        </div>
      </div>
      {error && <ErrorNote>{error}</ErrorNote>}
      {!skills && !error && <Loading />}
      {skills && items.length === 0 && (
        <EmptyState
          icon="sparkles"
          title={query ? "Ничего не найдено" : tab === "skills" ? "Скиллов пока нет" : tab === "commands" ? "Команд пока нет" : "Инструментов пока нет"}
          hint={!query && tab !== "tools" ? "Положите папку со SKILL.md в /data/skills или установите плагин со скиллами и командами." : undefined}
        />
      )}
      {items.length > 0 && (
        <div className="overflow-hidden rounded-2xl border border-border bg-surface shadow-card">
          {items.map((x, i) => (
            <div key={`${x.name}-${i}`} className={`px-4 py-3 ${i ? "border-t border-border" : ""}`}>
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-mono text-sm font-medium">{tab === "commands" ? `/${x.name.replace(/^\//, "")}` : x.name}</span>
                {"effect" in x ? (
                  <>
                    <Badge tone={EFFECT[(x as Tool).effect]?.tone ?? "info"}>{EFFECT[(x as Tool).effect]?.label ?? (x as Tool).effect}</Badge>
                    <Badge>{(x as Tool).owner}</Badge>
                    {(x as Tool).source && <Badge tone="warning">внешний контент</Badge>}
                  </>
                ) : (
                  <Badge>{(x as Skill).source}</Badge>
                )}
              </div>
              {x.description && <div className="mt-1 text-sm text-muted">{x.description}</div>}
            </div>
          ))}
        </div>
      )}
    </Page>
  );
}
