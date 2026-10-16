import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { QuickEntryApp } from "./components/QuickEntry";
import { initTheme } from "./lib/theme";
import "./styles/app.css";

initTheme();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <QuickEntryApp />
  </StrictMode>,
);
