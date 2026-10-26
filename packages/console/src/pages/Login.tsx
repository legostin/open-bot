import { useState, type FormEvent } from "react";
import { ExternalLink, Fingerprint, Lock } from "lucide-react";
import { api, errorText } from "../api.ts";
import type { AuthState } from "../types.ts";
import { passkeyUnavailableReason, loginWithPasskey } from "../webauthn.ts";
import { AccentStrip, Logo } from "../ui/brand.tsx";
import { Button, Callout, ErrorText, Field, PasswordInput } from "../ui/kit.tsx";
import { LocaleSwitch } from "../ui/locale.tsx";
import { t } from "../i18n/index.ts";

export function Login({ state, reason, onLoggedIn, onRecheck }: { state: AuthState; reason?: string; onLoggedIn: (csrf: string) => void; onRecheck: () => Promise<void> }) {
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState<"password" | "passkey">();
  const [error, setError] = useState<string>();
  const passkeyBlocked = state.passkeys > 0 ? passkeyUnavailableReason() : undefined;
  const canPasskey = state.passkeys > 0 && !passkeyBlocked;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!password) return;
    setBusy("password");
    setError(undefined);
    try {
      const r = await api.login(password);
      setPassword("");
      onLoggedIn(r.csrf);
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(undefined);
    }
  };

  const passkey = async () => {
    setBusy("passkey");
    setError(undefined);
    try {
      onLoggedIn(await loginWithPasskey());
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(undefined);
    }
  };

  return (
    <div className="flex min-h-dvh flex-col bg-bg">
      <AccentStrip />
      <div className="flex justify-end px-4 pt-4">
        <LocaleSwitch />
      </div>
      <main className="flex flex-1 items-center justify-center px-4 pb-12 pt-4">
        <div className="w-full max-w-sm">
          <div className="mb-6 flex flex-col items-center text-center">
            <Logo size="lg" />
            <h1 className="mt-4 text-2xl font-semibold tracking-tight text-fg">{t("app.name")}</h1>
            <p className="mt-1 text-sm text-muted">{t("login.subtitle")}</p>
          </div>

          <div className="rounded-2xl border border-line bg-surface p-5 shadow-sm sm:p-6">
            {reason && <Callout tone="brand" className="mb-4" title={reason} />}

            {!state.hasPassword ? (
              <div className="space-y-4">
                <Callout tone="warn" title={t("login.noPassword.title")}>
                  {t("login.noPassword.body")}
                </Callout>
                {state.publicUrl && (
                  <a
                    href={state.publicUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex h-11 w-full items-center justify-center gap-2 rounded-lg bg-brand px-4 text-sm font-medium text-white hover:bg-accent-800"
                  >
                    {t("login.openMainApp")} <ExternalLink className="size-4" />
                  </a>
                )}
                <Button className="w-full" onClick={() => void onRecheck()}>
                  {t("login.passwordSet")}
                </Button>
              </div>
            ) : (
              <div className="space-y-4">
                {canPasskey && (
                  <>
                    <Button variant="primary" size="lg" className="w-full" icon={<Fingerprint className="size-5" />} loading={busy === "passkey"} disabled={!!busy} onClick={passkey}>
                      {t("login.withPasskey")}
                    </Button>
                    <div className="flex items-center gap-3 text-xs text-faint">
                      <span className="h-px flex-1 bg-line" /> {t("login.orPassword")} <span className="h-px flex-1 bg-line" />
                    </div>
                  </>
                )}
                <form onSubmit={submit} className="space-y-4">
                  <Field label={t("login.password")} htmlFor="pw">
                    <PasswordInput id="pw" autoComplete="current-password" autoFocus={!canPasskey} value={password} onChange={(e) => setPassword(e.target.value)} required />
                  </Field>
                  <Button type="submit" variant={canPasskey ? "secondary" : "primary"} size="lg" className="w-full" loading={busy === "password"} disabled={!!busy || !password}>
                    {t("login.submit")}
                  </Button>
                </form>
                <ErrorText>{error}</ErrorText>
                {passkeyBlocked && <p className="text-xs leading-relaxed text-muted">{passkeyBlocked}</p>}
              </div>
            )}
          </div>

          <div className="mt-5 space-y-1.5 text-center text-xs leading-relaxed text-muted">
            <p className="inline-flex items-center gap-1.5">
              <Lock className="size-3.5" /> {t("login.address")} <span className="font-mono text-fg">{location.host}</span>
            </p>
            <p>{t("login.footnote")}</p>
          </div>
        </div>
      </main>
    </div>
  );
}
