// First-run setup (setup code + new password) and login (password or passkey).

import { useState, type FormEvent } from "react";
import { Fingerprint, KeyRound, Terminal } from "lucide-react";
import { startAuthentication } from "@simplewebauthn/browser";
import { errorText, request } from "../lib/api";
import { init, type AuthState } from "../state/app";
import { Button, ErrorNote, Field, Input } from "../components/ui";

function Logo() {
  return (
    <div className="mb-6 flex flex-col items-center gap-3">
      <img src="/favicon.svg" alt="" className="size-14" />
      <div className="text-center">
        <div className="text-2xl font-semibold tracking-tight">open-bot</div>
        <div className="text-sm text-muted">Ваш личный агент — на вашем железе</div>
      </div>
    </div>
  );
}

export function AuthScreen({ mode, auth }: { mode: "setup" | "login"; auth: AuthState }) {
  return (
    <div className="flex min-h-dvh items-center justify-center bg-bg px-4 py-10">
      <div className="w-full max-w-sm">
        <Logo />
        <div className="rounded-2xl border border-border bg-surface p-5 shadow-card sm:p-6">{mode === "setup" ? <SetupForm /> : <LoginForm auth={auth} />}</div>
        {auth.version && <div className="mt-4 text-center text-xs text-muted">версия {auth.version}</div>}
      </div>
    </div>
  );
}

function SetupForm() {
  const [token, setToken] = useState("");
  const [password, setPassword] = useState("");
  const [repeat, setRepeat] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError(undefined);
    if (password.length < 8) return setError("Пароль — минимум 8 символов");
    if (password !== repeat) return setError("Пароли не совпадают");
    setBusy(true);
    try {
      await request("POST", "/api/auth/setup", { token: token.trim(), password });
      await init();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form onSubmit={submit} className="flex flex-col gap-4">
      <div>
        <h1 className="text-lg font-semibold">Первый запуск</h1>
        <p className="mt-1 text-sm text-muted">Придумайте пароль для входа. Чтобы подтвердить, что это вы, введите код установки.</p>
      </div>
      <div className="flex gap-2.5 rounded-xl bg-surface-2 p-3 text-xs leading-relaxed text-muted">
        <Terminal className="mt-0.5 size-4 shrink-0" />
        <span>
          Код установки печатается в логах хаба при первом запуске: строка «введите код установки». В Docker: <code className="font-mono">docker logs openbot</code>
        </span>
      </div>
      <Field label="Код установки">
        <Input value={token} onChange={(e) => setToken(e.target.value)} autoComplete="one-time-code" autoFocus required spellCheck={false} className="font-mono" />
      </Field>
      <Field label="Новый пароль" hint="Минимум 8 символов">
        <Input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="new-password" required minLength={8} />
      </Field>
      <Field label="Повторите пароль">
        <Input type="password" value={repeat} onChange={(e) => setRepeat(e.target.value)} autoComplete="new-password" required />
      </Field>
      {error && <ErrorNote>{error}</ErrorNote>}
      <Button type="submit" variant="primary" loading={busy} className="w-full">
        Сохранить и войти
      </Button>
    </form>
  );
}

function LoginForm({ auth }: { auth: AuthState }) {
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState<"password" | "passkey" | undefined>();
  const [error, setError] = useState<string>();

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError(undefined);
    setBusy("password");
    try {
      await request("POST", "/api/auth/login", { password });
      await init();
    } catch (err) {
      setError(errorText(err));
      setBusy(undefined);
    }
  };

  const passkey = async () => {
    setError(undefined);
    setBusy("passkey");
    try {
      const optionsJSON = await request("POST", "/api/auth/passkey/options", {});
      const response = await startAuthentication({ optionsJSON });
      await request("POST", "/api/auth/passkey/verify", { response });
      await init();
    } catch (err) {
      const msg = errorText(err);
      setError(/NotAllowed|cancel|abort/i.test(msg) ? "Вход по passkey отменён" : msg);
      setBusy(undefined);
    }
  };

  return (
    <form onSubmit={submit} className="flex flex-col gap-4">
      <h1 className="text-lg font-semibold">Вход</h1>
      <Field label="Пароль">
        <Input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" autoFocus required />
      </Field>
      {error && <ErrorNote>{error}</ErrorNote>}
      <Button type="submit" variant="primary" loading={busy === "password"} disabled={!!busy} icon={<KeyRound className="size-4" />} className="w-full">
        Войти
      </Button>
      {auth.passkeys > 0 && (
        <>
          <div className="flex items-center gap-3 text-xs text-muted">
            <span className="h-px flex-1 bg-border" /> или <span className="h-px flex-1 bg-border" />
          </div>
          <Button onClick={passkey} loading={busy === "passkey"} disabled={!!busy} icon={<Fingerprint className="size-4" />} className="w-full">
            Войти с passkey
          </Button>
        </>
      )}
      <p className="text-center text-xs leading-relaxed text-muted">
        Забыли пароль? На сервере: <code className="font-mono">openbot reset-password &lt;новый&gt;</code>
      </p>
    </form>
  );
}
