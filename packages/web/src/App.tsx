import { useEffect } from "react";
import { Route, Switch, useLocation, useSearch } from "wouter";
import { useStore } from "./lib/store";
import { init, phase, session } from "./state/app";
import { openPanel } from "./state/panel";
import { syncUiPlugins, unloadAllUiPlugins } from "./plugins/host";
import { matchRoute } from "./plugins/registry";
import { usePluginRegistry } from "./plugins/slots";
import { PluginBoundary } from "./plugins/boundary";
import { AuthScreen } from "./pages/Auth";
import { Layout, TopBar } from "./components/Layout";
import { Toasts } from "./components/Toasts";
import { Button, EmptyState, Loading } from "./components/ui";
import { sectionForPath, type PanelSection } from "./components/nav";
import { ChatPage } from "./pages/chat/ChatPage";
import { TaskDetailPage } from "./pages/TaskDetail";
import { t } from "./i18n";

export function App() {
  const p = useStore(phase);
  useEffect(() => {
    void init();
  }, []);

  return (
    <>
      {p.kind === "loading" && (
        <div className="flex h-dvh items-center justify-center">
          <Loading text={t("app.connecting")} />
        </div>
      )}
      {p.kind === "error" && (
        <div className="flex h-dvh flex-col items-center justify-center gap-4 p-6">
          <EmptyState icon="wifi" title={t("app.hubUnavailable")} hint={p.message} />
          <Button variant="primary" onClick={() => void init()}>
            {t("common.retry")}
          </Button>
        </div>
      )}
      {(p.kind === "setup" || p.kind === "login") && <AuthScreen mode={p.kind} auth={p.auth} />}
      {p.kind === "ready" && <ReadyApp />}
      <Toasts />
    </>
  );
}

function ReadyApp() {
  const s = useStore(session);
  const uiPlugins = s?.uiPlugins;
  const key = JSON.stringify(uiPlugins ?? []);
  useEffect(() => {
    void syncUiPlugins(uiPlugins ?? []);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  useEffect(() => () => unloadAllUiPlugins(), []);

  return (
    <Layout>
      <Routes />
    </Layout>
  );
}

/** A former page URL: open its panel section over the main chat (keeping the query, e.g. /tasks?new=1). */
function OpenSection({ section }: { section: PanelSection }) {
  const [, navigate] = useLocation();
  const search = useSearch();
  useEffect(() => {
    openPanel(section);
    navigate(search ? `/?${search}` : "/", { replace: true });
  }, [section, search, navigate]);
  return <ChatPage />;
}

function Routes() {
  const [location] = useLocation();
  const { routes } = usePluginRegistry();
  const pluginRoute = matchRoute(routes, location);
  if (pluginRoute) {
    // Pages plugins put in the navigation open in the settings panel; other plugin routes are full views.
    const navRoute = routes.find((r) => r.key === pluginRoute.key && r.nav && !r.path.includes(":"));
    if (navRoute) return <OpenSection section={`plugin:${navRoute.key}`} />;
    const C = pluginRoute.component;
    return (
      <>
        <TopBar>
          <span className="truncate text-[15px] font-semibold">{routes.find((r) => r.key === pluginRoute.key)?.title}</span>
        </TopBar>
        <div className="min-h-0 flex-1 overflow-y-auto">
          <PluginBoundary key={pluginRoute.key} pluginId={pluginRoute.pluginId}>
            <C pluginId={pluginRoute.pluginId} />
          </PluginBoundary>
        </div>
      </>
    );
  }
  const section = sectionForPath(location);
  if (section) return <OpenSection section={section} />;
  return (
    <Switch>
      <Route path="/">{() => <ChatPage />}</Route>
      <Route path="/chat/:id">{(params) => <ChatPage conversationId={params.id} />}</Route>
      <Route path="/tasks/:id">{(params) => <TaskDetailPage id={params.id} />}</Route>
      <Route>
        <TopBar />
        <div className="flex min-h-0 flex-1 items-center justify-center">
          <EmptyState icon="compass" title={t("app.notFound")} hint={t("app.notFoundHint")} />
        </div>
      </Route>
    </Switch>
  );
}
