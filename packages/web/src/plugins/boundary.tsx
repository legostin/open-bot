// Error boundary around every plugin-provided component: a failing plugin never takes the app down.

import { Component, type ErrorInfo, type ReactNode } from "react";
import { TriangleAlert } from "lucide-react";
import { t } from "../i18n";

interface Props {
  pluginId: string;
  /** What to render instead (e.g. the core component for overrides). Default: a small note. */
  fallback?: ReactNode;
  /** Hide the note entirely (status bar items). */
  silent?: boolean;
  children: ReactNode;
}

export class PluginBoundary extends Component<Props, { error?: Error }> {
  state: { error?: Error } = {};

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error(`[ui-plugin ${this.props.pluginId}] render failed`, error, info.componentStack);
  }

  render() {
    if (!this.state.error) return this.props.children;
    if (this.props.fallback !== undefined) return this.props.fallback;
    if (this.props.silent) return null;
    return (
      <div className="flex items-center gap-2 rounded-lg border border-warning/30 bg-warning-soft px-2.5 py-1.5 text-xs text-warning" role="alert">
        <TriangleAlert className="size-3.5 shrink-0" />
        <span className="min-w-0 flex-1 truncate" title={this.state.error.message}>
          {t("plugins.renderFailed", { id: this.props.pluginId })}
        </span>
        <button type="button" className="shrink-0 underline underline-offset-2" onClick={() => this.setState({ error: undefined })}>
          {t("plugins.renderRetry")}
        </button>
      </div>
    );
  }
}
