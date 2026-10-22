// Перекраска растровых карт в стиль схем (нужен Chromium для работы с картинками — запускается через Electron).
// npm run sync делает это сам; отдельно: npx electron scripts/style-maps.mjs [--force]
import { app, net } from "electron";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { styleMaps } from "../electron/stylemaps.mjs";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

app.whenReady().then(async () => {
    try {
        await styleMaps({
            dataDir: path.join(ROOT, "public", "data"),
            outDir: path.join(ROOT, "public", "maps", "styled"),
            fetch: (u) => net.fetch(u),
            log: (m) => console.log(m),
            force: process.argv.includes("--force"),
        });
        console.log("Схемы карт готовы.");
    } catch (e) {
        console.error(e);
        process.exitCode = 1;
    }
    app.quit();
});
