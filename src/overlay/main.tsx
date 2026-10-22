import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "@fontsource/roboto-condensed/400.css";
import "@fontsource/roboto-condensed/700.css";
import "@fontsource/roboto-condensed/800.css";
import "./overlay.css";
import OverlayApp from "./OverlayApp";

createRoot(document.getElementById("root")!).render(
    <StrictMode>
        <OverlayApp />
    </StrictMode>,
);
