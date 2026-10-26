// UI of the memory plugin: page /memory with a folder tree, markdown view/edit, search and the review queue.

import { useCallback, useEffect, useMemo, useState, type CSSProperties, type ReactNode } from "react";
import { definePluginUI, Badge, Button, Card, EmptyState, Markdown, Spinner, type OpenBotUI } from "@openbot/ui";

interface FactMeta {
  path: string;
  title: string;
  tags: string[];
  created: string;
  updated: string;
  source: string;
  status: "active" | "review";
}

interface FactFile extends FactMeta {
  body: string;
  raw: string;
  pendingReview?: boolean;
  generated?: boolean;
}

interface Tree {
  facts: FactMeta[];
  folders: string[];
  review: number;
}

interface Hit {
  path: string;
  title: string;
  tags: string[];
  snippet: string;
}

interface ReviewItem extends FactMeta {
  body: string;
  inPlace: boolean;
  current?: { title: string; body: string; tags: string[]; updated: string };
}

type View = { kind: "empty" } | { kind: "file"; path: string } | { kind: "edit"; path?: string } | { kind: "review" } | { kind: "search"; q: string };

let UI: OpenBotUI;

const http = <T,>(method: "GET" | "POST" | "PUT" | "DELETE", path: string, body?: unknown) => UI.plugin.http<T>(method, path, body);
const q = (path: string) => encodeURIComponent(path);

function errText(e: any): string {
  return e?.body?.error ?? e?.error ?? e?.message ?? String(e);
}

function fmtDate(iso: string): string {
  if (!iso) return "";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString("ru-RU", { dateStyle: "medium", timeStyle: "short" });
}

const NEW_TEMPLATE = "---\ntitle: Новый факт\ntags: []\n---\n\n";

const s = {
  page: { display: "flex", gap: 16, height: "100%", minHeight: 0, padding: 16, boxSizing: "border-box" } as CSSProperties,
  side: { width: 300, flexShrink: 0, display: "flex", flexDirection: "column", gap: 8, minHeight: 0, overflow: "auto" } as CSSProperties,
  main: { flex: 1, minWidth: 0, overflow: "auto", display: "flex", flexDirection: "column", gap: 12 } as CSSProperties,
  input: { width: "100%", boxSizing: "border-box", padding: "6px 8px", borderRadius: 6, border: "1px solid rgba(127,127,127,.35)", background: "transparent", color: "inherit", font: "inherit" } as CSSProperties,
  textarea: { width: "100%", minHeight: 420, boxSizing: "border-box", padding: 10, borderRadius: 6, border: "1px solid rgba(127,127,127,.35)", background: "transparent", color: "inherit", fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace", fontSize: 13, lineHeight: 1.5, resize: "vertical" } as CSSProperties,
  row: { display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" } as CSSProperties,
  muted: { opacity: 0.65, fontSize: 12 } as CSSProperties,
  item: (active: boolean): CSSProperties => ({
    display: "block",
    width: "100%",
    textAlign: "left",
    padding: "4px 8px",
    borderRadius: 6,
    border: "none",
    cursor: "pointer",
    color: "inherit",
    font: "inherit",
    background: active ? "rgba(127,127,127,.18)" : "transparent",
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  }),
  folder: { display: "flex", alignItems: "center", gap: 6, width: "100%", padding: "4px 4px", border: "none", background: "transparent", color: "inherit", font: "inherit", fontWeight: 600, cursor: "pointer", textAlign: "left" } as CSSProperties,
  error: { color: "#d33", fontSize: 13 } as CSSProperties,
};

function FolderTree(props: { tree: Tree; selected?: string; onOpen(path: string): void }) {
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const groups = useMemo(() => {
    const m = new Map<string, FactMeta[]>();
    for (const f of props.tree.folders) m.set(f, []);
    for (const f of props.tree.facts) {
      const i = f.path.lastIndexOf("/");
      const dir = i < 0 ? "" : f.path.slice(0, i);
      m.set(dir, [...(m.get(dir) ?? []), f]);
    }
    return [...m.entries()].sort(([a], [b]) => (a === "" ? -1 : b === "" ? 1 : a.localeCompare(b)));
  }, [props.tree]);
  return (
    <div>
      {groups.map(([dir, facts]) => (
        <div key={dir || "/"}>
          {dir && (
            <button style={s.folder} onClick={() => setCollapsed((c) => ({ ...c, [dir]: !c[dir] }))}>
              <span style={{ width: 12 }}>{collapsed[dir] ? "▸" : "▾"}</span>
              <span>{dir}/</span>
              <span style={s.muted}>{facts.length}</span>
            </button>
          )}
          {!collapsed[dir] && (
            <div style={{ paddingLeft: dir ? 16 : 0 }}>
              {facts
                .slice()
                .sort((a, b) => a.title.localeCompare(b.title))
                .map((f) => (
                  <button key={f.path} title={f.path} style={s.item(props.selected === f.path)} onClick={() => props.onOpen(f.path)}>
                    {f.title}
                  </button>
                ))}
              {dir && !facts.length && <div style={{ ...s.muted, padding: "2px 8px" }}>пусто</div>}
            </div>
          )}
        </div>
      ))}
      <button style={{ ...s.item(props.selected === "MEMORY.md"), ...s.muted, marginTop: 8 }} onClick={() => props.onOpen("MEMORY.md")}>
        MEMORY.md — индекс
      </button>
    </div>
  );
}

function FileView(props: { path: string; version: number; onEdit(): void; onDeleted(): void }) {
  const [file, setFile] = useState<FactFile | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    let alive = true;
    setError("");
    http<FactFile>("GET", `/file?path=${q(props.path)}`)
      .then((f) => alive && setFile(f))
      .catch((e) => alive && (setFile(null), setError(errText(e))));
    return () => {
      alive = false;
    };
  }, [props.path, props.version]);

  if (error) return <EmptyState title="Не удалось открыть факт" hint={error} icon="brain" />;
  if (!file) return <Spinner />;
  const remove = async () => {
    if (!confirm(`Удалить «${file.title}»? Изменение останется в истории git.`)) return;
    try {
      await http("DELETE", `/file?path=${q(file.path)}`);
      UI.toast("Факт удалён", "success");
      props.onDeleted();
    } catch (e) {
      UI.toast(errText(e), "error");
    }
  };
  return (
    <Card
      title={file.title}
      actions={
        file.generated ? undefined : (
          <div style={s.row}>
            <Button size="sm" variant="secondary" onClick={props.onEdit}>
              Изменить
            </Button>
            <Button size="sm" variant="danger" onClick={remove}>
              Удалить
            </Button>
          </div>
        )
      }
    >
      <div style={{ ...s.row, marginBottom: 12 }}>
        <span style={s.muted}>{file.path}</span>
        {file.tags?.map((t) => (
          <Badge key={t}>{t}</Badge>
        ))}
        {file.status === "review" && <Badge tone="warning">на проверке</Badge>}
        {file.pendingReview && file.status !== "review" && <Badge tone="warning">есть версия на проверке</Badge>}
      </div>
      <Markdown text={file.body || "_Пусто_"} />
      {!file.generated && (
        <div style={{ ...s.muted, marginTop: 12 }}>
          {file.updated && <>Обновлено {fmtDate(file.updated)}</>}
          {file.source && <> · источник: {file.source}</>}
        </div>
      )}
    </Card>
  );
}

function Editor(props: { path?: string; onSaved(path: string): void; onCancel(): void }) {
  const [path, setPath] = useState(props.path ?? "notes/");
  const [text, setText] = useState<string | null>(props.path ? null : NEW_TEMPLATE);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    if (!props.path) return;
    http<FactFile>("GET", `/file?path=${q(props.path)}`)
      .then((f) => setText(f.raw))
      .catch((e) => setError(errText(e)));
  }, [props.path]);

  const save = async () => {
    setSaving(true);
    setError("");
    try {
      const p = path.trim().endsWith(".md") ? path.trim() : `${path.trim()}.md`;
      const f = await http<FactFile>("PUT", "/file", { path: p, content: text ?? "" });
      UI.toast("Сохранено", "success");
      props.onSaved(f.path);
    } catch (e) {
      setError(errText(e));
    } finally {
      setSaving(false);
    }
  };

  if (text === null && !error) return <Spinner />;
  return (
    <Card
      title={props.path ? `Редактирование: ${props.path}` : "Новый факт"}
      actions={
        <div style={s.row}>
          <Button size="sm" variant="primary" onClick={save} disabled={saving}>
            Сохранить
          </Button>
          <Button size="sm" variant="ghost" onClick={props.onCancel}>
            Отмена
          </Button>
        </div>
      }
    >
      {!props.path && (
        <label style={{ display: "block", marginBottom: 8 }}>
          <div style={s.muted}>Путь (папки: people/, projects/, notes/; файл .md)</div>
          <input style={s.input} value={path} onChange={(e) => setPath(e.target.value)} placeholder="people/anna.md" />
        </label>
      )}
      <div style={{ ...s.muted, marginBottom: 6 }}>Markdown с заголовком в блоке frontmatter (title, tags).</div>
      <textarea style={s.textarea} value={text ?? ""} onChange={(e) => setText(e.target.value)} spellCheck={false} />
      {error && <div style={s.error}>{error}</div>}
    </Card>
  );
}

function ReviewQueue(props: { version: number; onOpen(path: string): void }) {
  const [items, setItems] = useState<ReviewItem[] | null>(null);
  const [busy, setBusy] = useState("");
  const load = useCallback(() => {
    http<{ items: ReviewItem[] }>("GET", "/review")
      .then((r) => setItems(r.items))
      .catch((e) => (UI.toast(errText(e), "error"), setItems([])));
  }, []);
  useEffect(load, [load, props.version]);

  const act = async (item: ReviewItem, action: "approve" | "reject") => {
    setBusy(item.path);
    try {
      await http("POST", `/review/${action}`, { path: item.path });
      UI.toast(action === "approve" ? "Факт добавлен в память" : "Факт отклонён", action === "approve" ? "success" : "info");
      load();
    } catch (e) {
      UI.toast(errText(e), "error");
    } finally {
      setBusy("");
    }
  };

  if (!items) return <Spinner />;
  if (!items.length)
    return <EmptyState title="Нечего проверять" icon="brain" hint="Сюда попадают факты, которые агент записал после чтения недоверенного контента (веб-страниц, писем, внешних инструментов)." />;
  return (
    <>
      <div style={s.muted}>
        Эти факты агент записал в сессии, где читал недоверенный контент. Пока вы их не одобрите, они не попадают в поиск и в промпт агента.
      </div>
      {items.map((item) => (
        <Card
          key={item.path}
          title={item.title}
          actions={
            <div style={s.row}>
              <Button size="sm" variant="primary" disabled={busy === item.path} onClick={() => act(item, "approve")}>
                Одобрить
              </Button>
              <Button size="sm" variant="danger" disabled={busy === item.path} onClick={() => act(item, "reject")}>
                Отклонить
              </Button>
            </div>
          }
        >
          <div style={{ ...s.row, marginBottom: 8 }}>
            <span style={s.muted}>{item.path}</span>
            {item.tags.map((t) => (
              <Badge key={t}>{t}</Badge>
            ))}
            {item.current && <Badge tone="info">заменит существующий факт</Badge>}
          </div>
          <Markdown text={item.body || "_Пусто_"} />
          <div style={{ ...s.muted, marginTop: 8 }}>
            {fmtDate(item.updated)} · источник: {item.source || "неизвестен"}
          </div>
          {item.current && (
            <details style={{ marginTop: 8 }}>
              <summary style={{ cursor: "pointer" }}>Текущая версия</summary>
              <Markdown text={item.current.body || "_Пусто_"} />
              <Button size="sm" variant="ghost" onClick={() => props.onOpen(item.path)}>
                Открыть
              </Button>
            </details>
          )}
        </Card>
      ))}
    </>
  );
}

function SearchResults(props: { q: string; onOpen(path: string): void }) {
  const [hits, setHits] = useState<Hit[] | null>(null);
  useEffect(() => {
    setHits(null);
    http<{ results: Hit[] }>("GET", `/search?q=${q(props.q)}`)
      .then((r) => setHits(r.results))
      .catch((e) => (UI.toast(errText(e), "error"), setHits([])));
  }, [props.q]);
  if (!hits) return <Spinner />;
  if (!hits.length) return <EmptyState title={`Ничего не найдено по запросу «${props.q}»`} icon="brain" />;
  return (
    <>
      {hits.map((h) => (
        <Card key={h.path} title={h.title} actions={<Button size="sm" variant="secondary" onClick={() => props.onOpen(h.path)}>Открыть</Button>}>
          <div style={{ ...s.muted, marginBottom: 4 }}>{h.path}</div>
          <Markdown text={h.snippet} />
        </Card>
      ))}
    </>
  );
}

function MemoryPage() {
  const [tree, setTree] = useState<Tree | null>(null);
  const [view, setView] = useState<View>({ kind: "empty" });
  const [query, setQuery] = useState("");
  const [version, setVersion] = useState(0);
  const [error, setError] = useState("");

  const loadTree = useCallback(() => {
    http<Tree>("GET", "/tree")
      .then((t) => (setTree(t), setError("")))
      .catch((e) => setError(errText(e)));
  }, []);

  useEffect(() => {
    loadTree();
    return UI.plugin.on("changed", () => {
      loadTree();
      setVersion((v) => v + 1);
    });
  }, [loadTree]);

  const open = (path: string) => setView({ kind: "file", path });
  const selected = view.kind === "file" ? view.path : undefined;

  let content: ReactNode;
  switch (view.kind) {
    case "file":
      content = <FileView path={view.path} version={version} onEdit={() => setView({ kind: "edit", path: view.path })} onDeleted={() => (setView({ kind: "empty" }), loadTree())} />;
      break;
    case "edit":
      content = <Editor path={view.path} onSaved={(p) => (loadTree(), open(p))} onCancel={() => setView(view.path ? { kind: "file", path: view.path } : { kind: "empty" })} />;
      break;
    case "review":
      content = <ReviewQueue version={version} onOpen={open} />;
      break;
    case "search":
      content = <SearchResults q={view.q} onOpen={open} />;
      break;
    default:
      content = (
        <EmptyState
          title="Память"
          icon="brain"
          hint="Здесь хранится то, что агент знает о вас: профиль, люди, проекты и заметки. Выберите факт слева, найдите нужное или добавьте новый."
        />
      );
  }

  return (
    <div style={s.page}>
      <div style={s.side}>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (query.trim()) setView({ kind: "search", q: query.trim() });
          }}
        >
          <input style={s.input} type="search" placeholder="Поиск по памяти…" value={query} onChange={(e) => setQuery(e.target.value)} />
        </form>
        <div style={s.row}>
          <Button size="sm" variant="secondary" onClick={() => setView({ kind: "edit" })}>
            Новый факт
          </Button>
          <Button size="sm" variant={tree?.review ? "primary" : "ghost"} onClick={() => setView({ kind: "review" })}>
            {`На проверке${tree?.review ? ` (${tree.review})` : ""}`}
          </Button>
        </div>
        {error && <div style={s.error}>{error}</div>}
        {tree ? <FolderTree tree={tree} selected={selected} onOpen={open} /> : !error && <Spinner />}
      </div>
      <div style={s.main}>{content}</div>
    </div>
  );
}

export default definePluginUI((ui) => {
  UI = ui;
  return ui.routes.add({ path: "/memory", title: "Память", icon: "brain", component: MemoryPage, nav: true });
});
