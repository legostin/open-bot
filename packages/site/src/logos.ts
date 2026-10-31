// The services the catalog connects, with the logos their plugins already ship (bundled at build time).

const files = import.meta.glob(["../../../integrations/*/logos/*.png", "../../../integrations/*/logo.png", "../../../plugins/*/logo.png"], {
  eager: true,
  import: "default",
}) as Record<string, string>;

function logo(file: string): string | undefined {
  return Object.entries(files).find(([p]) => p.endsWith(file))?.[1];
}

const SERVICES: Array<[string, string?]> = [
  ["Gmail", "composio/logos/gmail.png"],
  ["Google Calendar", "composio/logos/googlecalendar.png"],
  ["Slack", "composio/logos/slack.png"],
  ["GitHub", "composio/logos/github.png"],
  ["Notion", "notion/logo.png"],
  ["Linear", "linear/logo.png"],
  ["Telegram", "telegram/logo.png"],
  ["Google Drive", "composio/logos/googledrive.png"],
  ["Google Docs", "composio/logos/googledocs.png"],
  ["Google Sheets", "composio/logos/googlesheets.png"],
  ["Outlook", "composio/logos/outlook.png"],
  ["Teams", "composio/logos/microsoft_teams.png"],
  ["Zoom", "composio/logos/zoom.png"],
  ["Google Meet", "composio/logos/googlemeet.png"],
  ["Jira", "composio/logos/jira.png"],
  ["Trello", "composio/logos/trello.png"],
  ["Figma", "composio/logos/figma.png"],
  ["Dropbox", "composio/logos/dropbox.png"],
  ["OneDrive", "composio/logos/one_drive.png"],
  ["Box", "composio/logos/box.png"],
  ["Calendly", "composio/logos/calendly.png"],
  ["Google Tasks", "composio/logos/googletasks.png"],
  ["HubSpot", "composio/logos/hubspot.png"],
  ["Salesforce", "composio/logos/salesforce.png"],
  ["LinkedIn", "composio/logos/linkedin.png"],
  ["YouTube", "composio/logos/youtube.png"],
  ["Reddit", "composio/logos/reddit.png"],
  ["Granola"],
  ["Blender"],
];

export const LOGOS = SERVICES.map(([name, file]) => ({ name, src: file ? logo(file) : undefined }));
