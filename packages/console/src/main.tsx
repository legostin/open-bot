import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./index.css";
import { applyTheme } from "./prefs.ts";
import { applyLocale } from "./i18n/index.ts";
import { App } from "./App.tsx";

applyTheme();
applyLocale();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
