import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "leaflet/dist/leaflet.css";
import "@fontsource/roboto-condensed/400.css";
import "@fontsource/roboto-condensed/700.css";
import "@fontsource/roboto-condensed/800.css";
import "./styles.css";
import App from "./App";

createRoot(document.getElementById("root")!).render(
    <StrictMode>
        <App />
    </StrictMode>,
);
