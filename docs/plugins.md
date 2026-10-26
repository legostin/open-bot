# Плагины

Почти всё в open-bot — плагины: мозги (Claude Code, Codex, API), каналы (Telegram), браузер, память, веб-поиск, триггеры. Ядро только связывает их и следит за безопасностью. Плагин может добавить:

| Что | Где |
|---|---|
| Инструменты для агентов | `server/` → `ctx.tools.register` |
| Мозг (харнесс или API) | `server/` → `ctx.brains.register` |
| Канал (мессенджер) | `server/` → `ctx.channels.register` |
| Хуки (`tool.before`, `message.in`, …) | `server/` → `ctx.hooks.on` |
| HTTP-эндпоинты (вебхуки, API для своего UI) | `server/` → `ctx.http.handle` |
| Скиллы, команды, агенты | `skills/`, `commands/`, `agents/` |
| MCP-серверы | `.mcp.json` |
| Интерфейс: панели, вкладки, рендер результатов, замена композера | `ui/` |

Плагины Claude Code (`.claude-plugin/plugin.json`) и Codex (`.codex-plugin/plugin.json`) ставятся как есть: их скиллы, команды, агенты, MCP-серверы и хуки становятся доступны.

## Структура

```
my-plugin/
  .openbot-plugin/plugin.json
  server/index.ts        # бэкенд: отдельный процесс, JSON-RPC по stdio
  ui/src/index.tsx       # UI-модуль (собирается в ui/dist/index.js)
  skills/<name>/SKILL.md
  commands/<name>.md
  agents/<name>.md
  .mcp.json
```

## Манифест

```json
{
  "id": "weather",
  "name": "Погода",
  "version": "0.1.0",
  "server": "./server/index.ts",
  "ui": "./ui/dist/index.js",
  "toolPrefix": "weather",
  "contributes": {
    "tools": true,
    "http": true,
    "settings": { "type": "object", "properties": { "city": { "type": "string", "title": "Город" } } }
  },
  "permissions": {
    "network": ["api.open-meteo.com"],
    "vault": [],
    "core": ["notify"]
  }
}
```

- Инструменты называются `<toolPrefix>_<name>` (по умолчанию префикс — `id` с `_` вместо `-`).
- `permissions.network` — куда плагину можно ходить. Весь трафик идёт через egress-прокси ядра; остальное запрещено (в Docker с `NET_ADMIN` — жёстко, через iptables).
- `permissions.vault` — id записей vault или `login:*`. Даже разрешённая запись отдаётся, только если её область (scope) включает этот плагин.
- `permissions.core` — методы ядра: `conversations.post`, `channels.inbound`, `tasks.create|get|list`, `notify`, `approvals.resolve`, `settings.get`, `agents.list`, `ui.emit`, `vault.check`, `machines.list`, `notifications.feedback`.

Права показываются при установке. Плагин из git закрепляется на хэше коммита.

## Бэкенд

```ts
import { definePlugin } from "@openbot/plugin-sdk";

export default definePlugin({
  async activate(ctx) {
    ctx.tools.register({
      name: "forecast",
      description: "Прогноз погоды на завтра",
      effect: "read", // read | local-write | external (external → подтверждение пользователя)
      inputSchema: { type: "object", properties: { city: { type: "string" } } },
      handler: async ({ city }) => {
        const r = await fetch(`https://api.open-meteo.com/...${encodeURIComponent(city ?? ctx.settings.city)}`);
        return await r.text(); // строка или { content: [...] }
      },
    });
    ctx.hooks.on("tool.before", (call) => (call.tool === "mail_send" && /urgent/i.test(JSON.stringify(call.input)) ? { block: "без срочных писем" } : undefined));
    ctx.http.handle(async (req) => ({ status: 200, body: { ok: true } })); // /api/plugins/weather/http/* (и /hooks/weather/* при public)
  },
});
```

Что есть в `ctx`: `settings`, `onSettingsChange`, `log`, `tools`, `brains`, `channels`, `events`, `hooks`, `http`, `ui.emit / ui.onMessage`, `vault.get`, `storage` (kv плагина), `core.call`, `dataDir` (личная папка).

Для `effect: "external"` можно задать `approvalSummary: "Отправить {text} в {chat}"` — так действие будет показано в карточке подтверждения.

Хук не может разрешить то, что политика запретила или отправила на подтверждение: хуки выполняются до политики и могут только заблокировать вызов или изменить вход.

## Мозги

Мозг — это `BrainProviderImpl`: `probe()` (установлен? есть вход?) и `createSession(opts)`. Сессия получает системный промпт, рабочую папку и MCP-доступ к инструментам хаба (`opts.mcp.url`, `opts.mcp.token`, `opts.mcp.bridgeCommand` для stdio-клиентов). `send(turn)` выдаёт события `text`, `tool_call`, `tool_result`, `usage`, `limit_hit`, `error`, `done`. При `limit_hit` ядро помечает мозг занятым до `resetAt` и переключается на следующий в списке агента. Готовые адаптеры для CLI — в `@openbot/brains-cli`. Если у мозга есть варианты (например, провайдеры API), перечислите их в `variants: ["anthropic", "openai"]` — в интерфейсе они появятся отдельными мозгами `<id>:<вариант>@local`, а вариант придёт в `probe(variant)` и `opts.variant`.

## UI

UI-модуль — ES-модуль; React и `@openbot/ui` берутся у хоста через import map, поэтому в сборку не попадают.

```tsx
import { definePluginUI, Card, useHubEvent } from "@openbot/ui";

export default definePluginUI({
  activate(ui) {
    ui.slots.register("sidebar.panel", { id: "weather", title: "Погода", icon: "☀", component: Panel });
    ui.slots.register("chat.toolResult", { id: "forecast", match: { tool: "weather_*" }, component: ForecastCard });
    ui.statusbar.add({ id: "temp", render: () => <span>+12°</span> });
  },
});
```

Слоты: `layout.sidebar`, `layout.statusbar`, `sidebar.panel`, `pane.right`, `chat.message`, `chat.toolResult`, `chat.composer`, `chat.composerActions`, `settings.section`, `route`. `ui.slots.override(slot, Component, { priority })` заменяет стандартный компонент целиком. Каждый слот обёрнут в error boundary.

Сборка всех UI-плагинов: `npm run build:ui-plugins` (`plugins/*/ui/src/index.tsx` → `ui/dist/index.js`).

**Доверие.** UI-плагин — доверенный код в основной странице. Поэтому подтверждения, vault, правила и аудит живут на отдельном origin (порт 8081), а CSP основной страницы не даёт отправить данные на чужой сервер.

## Тесты

`@openbot/testkit` запускает плагин как настоящий процесс и эмулирует ядро:

```ts
import { startPlugin } from "@openbot/testkit";
const p = await startPlugin({ dir: "plugins/weather", settings: { city: "Berlin" } });
expect(await p.invokeText("weather_forecast", {})).toContain("°");
await p.stop();
```

Для мозгов есть `brainProbe`, `brainCreate`, `brainSend`; для API-мозгов — фейковый LLM-сервер `startMockLlm`.

## Установка

В веб-интерфейсе: «Плагины → Установить» (git URL или путь), затем подтверждение прав. Или положите плагин в `/data/plugins/<id>` и подтвердите его в интерфейсе.
