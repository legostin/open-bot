import { useEffect } from "react";
import { Route, Switch, useLocation, useSearch } from "wouter";
import { useStore } from "./lib/store";
import { agentPath } from "./lib/team";
import { conversations, init, phase, session, team } from "./state/app";
import { openPanel } from "./state/panel";
import { useUiPlugins } from "./plugins/host";
import { matchRoute } from "./plugins/registry";
import { usePluginRegistry } from "./plugins/slots";
import { PluginBoundary } from "./plugins/boundary";
import { AuthScreen } from "./pages/Auth";
import { Layout, TopBar } from "./components/Layout";
import { Toasts } from "./components/Toasts";
import { Button, EmptyState, Loading } from "./components/ui";
import { sectionForPath, type PanelSection } from "./components/nav";
import { ChatPage } from "./pages/chat/ChatPage";
import { AgentPage } from "./pages/chat/AgentPage";
import { TaskDetailPage } from "./pages/TaskDetail";
import { ChannelPage } from "./pages/channels/ChannelPage";
import { MobileApp, useMobileReadyOnError } from "./pages/MobileApp";
import { mobileMode } from "./lib/mobile";
import { t } from "./i18n";

export function App() {
  const p = useStore(phase);
  useEffect(() => {
    void init();
  }, []);
  useMobileReadyOnError(p.kind === "error");

  return (
    <>
      {p.kind === "loading" && (
        <div className="flex h-dvh items-center justify-center">
          <Loading text={t("app.connecting")} />
        </div>
      )}
      {p.kind === "reauth" && (
        <div className="flex h-dvh items-center justify-center">
          <Loading text={t("app.reauth")} />
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
      {p.kind === "ready" && (mobileMode ? <MobileApp /> : <ReadyApp />)}
      <Toasts />
    </>
  );
}

function ReadyApp() {
  useUiPlugins();
  return (
    <Layout>
      <Routes />
    </Layout>
  );
}

/** A former page URL: open its panel section over the default agent's dialog (keeping the query, e.g. /tasks?new=1). */
function OpenSection({ section }: { section: PanelSection }) {
  const [, navigate] = useLocation();
  const search = useSearch();
  useEffect(() => {
    openPanel(section);
    navigate(search ? `/?${search}` : "/", { replace: true });
  }, [section, search, navigate]);
  return <AgentPage />;
}

/** /chat/:id: an agent's dialog moves to its own address; older chats still open here. */
function ChatRoute({ id }: { id: string }) {
  const [, navigate] = useLocation();
  const s = useStore(session);
  const convs = useStore(conversations);
  const members = useStore(team);
  const conv = convs.find((c) => c.id === id);
  const dialogOf = conv?.kind === "main" ? conv.agentId : members?.find((m) => m.conversationId === id)?.agentId;
  useEffect(() => {
    if (dialogOf) navigate(agentPath(dialogOf, s?.defaultAgent), { replace: true });
  }, [dialogOf, s?.defaultAgent, navigate]);
  return dialogOf ? null : <ChatPage conversationId={id} />;
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
      <Route path="/">{() => <AgentPage />}</Route>
      <Route path="/agent/:id">{(params) => <AgentPage key={params.id} agentId={params.id} />}</Route>
      <Route path="/chat/:id">{(params) => <ChatRoute id={params.id} />}</Route>
      <Route path="/tasks/:id">{(params) => <TaskDetailPage id={params.id} />}</Route>
      <Route path="/channels/:id">{(params) => <ChannelPage key={params.id} id={params.id} />}</Route>
      <Route>
        <TopBar />
        <div className="flex min-h-0 flex-1 items-center justify-center">
          <EmptyState icon="compass" title={t("app.notFound")} hint={t("app.notFoundHint")} />
        </div>
      </Route>
    </Switch>
  );
}
