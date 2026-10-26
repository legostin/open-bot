// Attention signals for new approvals: a short chime (WebAudio, no files) and browser notifications.

import { getPrefs } from "./prefs.ts";
import { t } from "./i18n/index.ts";

let audio: AudioContext | undefined;

/** Create/resume the audio context from a user gesture so later chimes are allowed to play. */
export function primeAudio(): void {
  try {
    audio ??= new AudioContext();
    if (audio.state === "suspended") void audio.resume();
  } catch {
    /* no audio */
  }
}

export function chime(): void {
  if (!getPrefs().sound) return;
  try {
    audio ??= new AudioContext();
    const t0 = audio.currentTime + 0.01;
    for (const [offset, freq] of [
      [0, 784],
      [0.16, 1175],
    ] as const) {
      const osc = audio.createOscillator();
      const gain = audio.createGain();
      osc.type = "sine";
      osc.frequency.value = freq;
      gain.gain.setValueAtTime(0.0001, t0 + offset);
      gain.gain.exponentialRampToValueAtTime(0.16, t0 + offset + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, t0 + offset + 0.45);
      osc.connect(gain).connect(audio.destination);
      osc.start(t0 + offset);
      osc.stop(t0 + offset + 0.5);
    }
  } catch {
    /* no audio */
  }
}

export function notificationsSupported(): boolean {
  return typeof Notification !== "undefined" && window.isSecureContext;
}

export function notificationPermission(): NotificationPermission | "unsupported" {
  return notificationsSupported() ? Notification.permission : "unsupported";
}

/** OS-level notification while the console is in the background. No input details: they may show on a lock screen. */
export function notifyApproval(a: { id: string; agentId: string; tool: string }): void {
  if (!getPrefs().notify || notificationPermission() !== "granted" || document.visibilityState === "visible") return;
  try {
    const n = new Notification(t("notify.title"), {
      body: t("notify.body", { agent: a.agentId, tool: a.tool }),
      tag: `approval-${a.id}`,
      icon: "./favicon.svg",
    });
    n.onclick = () => {
      window.focus();
      location.hash = `#/approvals/${encodeURIComponent(a.id)}`;
      n.close();
    };
  } catch {
    /* some mobile browsers only allow notifications from a service worker */
  }
}
