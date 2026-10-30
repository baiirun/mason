import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { MuxProvider, MuxRoot } from "@mason/react";
import "@mason/react/src/styles.css";
import "./blocks/blocks.css";
import { registry } from "./blocks";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    {/* In inspect this sits inside the app's real providers (query client, auth, theme). */}
    <MuxProvider registry={registry}>
      <MuxRoot />
    </MuxProvider>
  </StrictMode>,
);
