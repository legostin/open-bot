// Passkey ceremonies via @simplewebauthn/browser, with Russian error messages.

import { browserSupportsWebAuthn, startAuthentication, startRegistration, WebAuthnError } from "@simplewebauthn/browser";
import { api } from "./api.ts";

/** WebAuthn relying-party ids must be domain names: browsers refuse passkeys on raw IP addresses. */
export function isIpHost(hostname: string): boolean {
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(hostname) || hostname.startsWith("[") || hostname.includes(":");
}

/** Why passkeys cannot be used here, or undefined if they can. */
export function passkeyUnavailableReason(): string | undefined {
  if (!window.isSecureContext) return "Passkey работают только по HTTPS или на localhost.";
  if (!browserSupportsWebAuthn()) return "Этот браузер не поддерживает passkey.";
  if (isIpHost(location.hostname)) {
    return `Passkey не работают по IP-адресу. Откройте пульт по имени хоста (например, http://localhost:${location.port || "8081"}) и укажите это имя в OPENBOT_PUBLIC_URL.`;
  }
  return undefined;
}

export function passkeysSupported(): boolean {
  return !passkeyUnavailableReason();
}

function explain(e: unknown): Error {
  if (e instanceof WebAuthnError) {
    switch (e.code) {
      case "ERROR_CEREMONY_ABORTED":
        return new Error("Операция с passkey отменена");
      case "ERROR_INVALID_DOMAIN":
      case "ERROR_INVALID_RP_ID":
        return new Error("Passkey недоступен на этом адресе: откройте пульт по тому же имени хоста, что указано в OPENBOT_PUBLIC_URL");
      case "ERROR_AUTHENTICATOR_PREVIOUSLY_REGISTERED":
        return new Error("Этот ключ уже зарегистрирован");
    }
  }
  if (e instanceof Error && (e.name === "NotAllowedError" || e.name === "AbortError")) return new Error("Операция с passkey отменена или время ожидания истекло");
  return e instanceof Error ? e : new Error(String(e));
}

/** Returns the new csrf token. */
export async function loginWithPasskey(): Promise<string> {
  const optionsJSON = await api.passkeyLoginOptions();
  let response;
  try {
    response = await startAuthentication({ optionsJSON });
  } catch (e) {
    throw explain(e);
  }
  const r = await api.passkeyLoginVerify(response);
  return r.csrf;
}

export async function registerPasskey(name: string) {
  const optionsJSON = await api.passkeyRegisterOptions();
  let response;
  try {
    response = await startRegistration({ optionsJSON });
  } catch (e) {
    throw explain(e);
  }
  return api.passkeyRegister(response, name);
}
