// Tabs: a strip like Chrome's on a wide view, a full-view list of cards on the phone.

import { Clock, Plus, X } from "lucide-react";
import { Favicon, IconButton } from "./chrome.tsx";
import { hostOf, isBlank, send, t, type Tab } from "./host.ts";

export const tabTitle = (tab: Tab) => tab.title || (isBlank(tab.url) ? t("ui.tab.new") : hostOf(tab.url) || tab.url);

const close = (tab: Tab) => send({ type: "tab", action: "close", index: tab.index });
const show = (tab: Tab) => !tab.active && send({ type: "tab", action: "switch", index: tab.index });
const newTab = () => send({ type: "tab", action: "new" });

export function TabStrip({ tabs }: { tabs: Tab[] }) {
  return (
    <div className="obb-tabs" role="tablist">
      {tabs.map((tab) => (
        <div
          key={tab.index}
          role="tab"
          aria-selected={tab.active}
          className="obb-tab"
          title={tab.url && !isBlank(tab.url) ? `${tabTitle(tab)}\n${tab.url}` : tabTitle(tab)}
          // The middle button closes a tab, as in every browser.
          onMouseDown={(e) => {
            if (e.button !== 1) return;
            e.preventDefault();
            close(tab);
          }}
          onClick={() => show(tab)}
        >
          <Favicon icon={tab.icon} loading={tab.loading} />
          <span className="obb-tab-title obb-trunc">{tabTitle(tab)}</span>
          <IconButton
            label={t("ui.tab.close")}
            onClick={(e) => {
              e.stopPropagation();
              close(tab);
            }}
          >
            <X />
          </IconButton>
        </div>
      ))}
      <IconButton className="obb-newtab" label={t("ui.tab.new")} onClick={newTab}>
        <Plus />
      </IconButton>
    </div>
  );
}

export function TabSwitcher({ tabs, onClose, onHistory }: { tabs: Tab[]; onClose: () => void; onHistory: () => void }) {
  return (
    <div className="obb-sheet" role="dialog" aria-label={t("ui.tabs.title", { count: tabs.length })}>
      <div className="obb-head">
        <span className="obb-head-title">{t("ui.tabs.title", { count: tabs.length })}</span>
        <IconButton label={t("ui.close")} onClick={onClose}>
          <X />
        </IconButton>
      </div>
      <div className="obb-cards">
        {tabs.map((tab) => (
          <div
            key={tab.index}
            className="obb-card"
            role="button"
            aria-selected={tab.active}
            onClick={() => {
              show(tab);
              onClose();
            }}
          >
            <Favicon icon={tab.icon} loading={tab.loading} />
            <div className="obb-visit-text">
              <div className="obb-trunc">{tabTitle(tab)}</div>
              {!isBlank(tab.url) && <div className="obb-visit-sub obb-trunc">{hostOf(tab.url) || tab.url}</div>}
            </div>
            <IconButton
              label={t("ui.tab.close")}
              onClick={(e) => {
                e.stopPropagation();
                close(tab);
              }}
            >
              <X />
            </IconButton>
          </div>
        ))}
      </div>
      <div className="obb-sheet-foot">
        <button type="button" className="obb-btn" onClick={onHistory}>
          <Clock aria-hidden />
          {t("ui.history.title")}
        </button>
        <button
          type="button"
          className="obb-btn"
          onClick={() => {
            newTab();
            onClose();
          }}
        >
          <Plus aria-hidden />
          {t("ui.tab.new")}
        </button>
      </div>
    </div>
  );
}
