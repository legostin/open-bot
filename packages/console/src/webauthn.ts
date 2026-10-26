// Passkey ceremonies via @simplewebauthn/browser, with Russian error messages.

import { browserSupportsWebAuthn, startAuthentication, startRegistration, WebAuthnError } from "@simplewebauthn/browser";
import { api } from "./api.ts";
import { t } from "./i18n/index.ts";

/** WebAuthn relying-party ids must be domain names: browsers refuse passkeys on raw IP addresses. */
export function isIpHost(hostname: string): boolean {
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(hostname) || hostname.startsWith("[") || hostname.includes(":");
}

/** Why passkeys cannot be used here, or undefined if they can. */
export function passkeyUnavailableReason(): string | undefined {
  if (!window.isSecureContext) return t("webauthn.insecure");
  if (!browserSupportsWebAuthn()) return t("webauthn.unsupported");
  if (isIpHost(location.hostname)) {
    return t("webauthn.ipHost", { port: location.port || "8081" });
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
        return new Error(t("webauthn.aborted"));
      case "ERROR_INVALID_DOMAIN":
      case "ERROR_INVALID_RP_ID":
        return new Error(t("webauthn.badDomain"));
      case "ERROR_AUTHENTICATOR_PREVIOUSLY_REGISTERED":
        return new Error(t("webauthn.alreadyRegistered"));
    }
  }
  if (e instanceof Error && (e.name === "NotAllowedError" || e.name === "AbortError")) return new Error(t("webauthn.timeout"));
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
