import * as React from "react";
import * as ReactDOM from "react-dom";
import * as ReactDOMClient from "react-dom/client";
import * as JsxRuntime from "react/jsx-runtime";
import { uiRuntime } from "./plugins/runtime";
import { App } from "./App";
import "./index.css";

// Shared instances for UI plugins: the import map points "react", "react-dom", "@openbot/ui", ... at
// /shared/*.js shims that read from here. Must be set before any UI plugin module is imported.
window.__OPENBOT_SHARED__ = {
  react: React,
  reactDom: ReactDOM,
  reactDomClient: ReactDOMClient,
  jsxRuntime: JsxRuntime,
  ui: uiRuntime,
};

ReactDOMClient.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
