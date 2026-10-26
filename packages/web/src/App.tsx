import { useEffect } from "react";
import { Route, Switch, useLocation } from "wouter";
import { useStore } from "./lib/store";
import { init, phase, session } from "./state/app";
import { syncUiPlugins, unloadAllUiPlugins } from "./plugins/host";
import { matchRoute } from "./plugins/registry";
import { usePluginRegistry } from "./plugins/slots";
import { PluginBoundary } from "./plugins/boundary";
import { AuthScreen } from "./pages/Auth";
import { Layout } from "./components/Layout";
import { Toasts } from "./components/Toasts";
import { Button, EmptyState, Loading } from "./components/ui";
import { ChatPage } from "./pages/chat/ChatPage";
import { TasksPage } from "./pages/Tasks";
import { TaskDetailPage } from "./pages/TaskDetail";
import { AgentsPage } from "./pages/Agents";
import { BrainsPage } from "./pages/Brains";
import { PluginsPage } from "./pages/Plugins";
import { MachinesPage } from "./pages/Machines";
import { McpPage } from "./pages/Mcp";
import { NotificationsPage } from "./pages/Notifications";
import { SkillsPage } from "./pages/Skills";
import { SettingsPage } from "./pages/Settings";
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

function Routes() {
  const [location] = useLocation();
  const { routes } = usePluginRegistry();
  const pluginRoute = matchRoute(routes, location);
  if (pluginRoute) {
    const C = pluginRoute.component;
    return (
      <div className="h-full overflow-y-auto">
        <PluginBoundary key={pluginRoute.key} pluginId={pluginRoute.pluginId}>
          <C pluginId={pluginRoute.pluginId} />
        </PluginBoundary>
      </div>
    );
  }
  return (
    <Switch>
      <Route path="/">{() => <ChatPage />}</Route>
      <Route path="/chat/:id">{(params) => <ChatPage conversationId={params.id} />}</Route>
      <Route path="/tasks">{() => <TasksPage />}</Route>
      <Route path="/tasks/:id">{(params) => <TaskDetailPage id={params.id} />}</Route>
      <Route path="/agents">{() => <AgentsPage />}</Route>
      <Route path="/brains">{() => <BrainsPage />}</Route>
      <Route path="/plugins">{() => <PluginsPage />}</Route>
      <Route path="/machines">{() => <MachinesPage />}</Route>
      <Route path="/mcp-servers">{() => <McpPage />}</Route>
      <Route path="/notifications">{() => <NotificationsPage />}</Route>
      <Route path="/skills">{() => <SkillsPage />}</Route>
      <Route path="/settings">{() => <SettingsPage />}</Route>
      <Route>
        <div className="flex h-full items-center justify-center">
          <EmptyState icon="compass" title={t("app.notFound")} hint={t("app.notFoundHint")} />
        </div>
      </Route>
    </Switch>
  );
}
