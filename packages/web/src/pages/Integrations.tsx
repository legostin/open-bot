// The integrations library: every service the agents can work with, as cards to connect, set up or turn on.

import { useState } from "react";
import { errorText } from "../lib/api";
import { loadIntegrations, useIntegrations } from "../state/integrations";
import { t } from "../i18n";
import { IntegrationCard } from "../components/IntegrationCard";
import { EmptyState, ErrorNote, Loading, Page } from "../components/ui";

export function IntegrationsPage() {
  const list = useIntegrations();
  const [error, setError] = useState<string>();
  const retry = () => loadIntegrations().then(() => setError(undefined), (e) => setError(errorText(e)));
  return (
    <Page title={t("nav.integrations")} subtitle={t("integrations.intro")}>
      {error && <ErrorNote onRetry={() => void retry()}>{error}</ErrorNote>}
      {!list && !error && <Loading />}
      {list && !list.length && <EmptyState icon="puzzle" title={t("integrations.empty")} />}
      {list && list.length > 0 && (
        // Two columns once the page itself is wide (the panel beside the chat is narrow on any screen).
        <div className="@container">
          <div className="grid gap-3 @2xl:grid-cols-2">
            {list.map((v) => (
              <IntegrationCard key={v.id} view={v} />
            ))}
          </div>
        </div>
      )}
    </Page>
  );
}
