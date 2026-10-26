import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./index.css";
import { applyTheme } from "./prefs.ts";
import { App } from "./App.tsx";

applyTheme();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
