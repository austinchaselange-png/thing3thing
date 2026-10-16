import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { QuickEntryApp } from "./components/QuickEntry";
import "./styles/app.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <QuickEntryApp />
  </StrictMode>,
);
