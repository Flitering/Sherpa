// Разработка десктоп-версии: поднимает dev-сервер Vite и открывает Electron поверх него.
// npm run desktop:dev
import { createServer } from "vite";
import { spawn } from "node:child_process";
import electron from "electron";

const server = await createServer();
await server.listen();
const url = server.resolvedUrls.local[0].replace(/\/$/, "");
console.log(`Vite: ${url}`);

const child = spawn(electron, ["."], { stdio: "inherit", env: { ...process.env, SHERPA_DEV_URL: url } });
child.on("exit", async (code) => {
    await server.close();
    process.exit(code ?? 0);
});
