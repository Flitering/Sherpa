// Обновление по кнопке: проверка релизов на GitHub, скачивание только изменившихся частей
// (blockmap), установка поверх в ту же папку, которую пользователь выбрал при установке.

import { app } from "electron";
import updaterPkg from "electron-updater";

const { autoUpdater } = updaterPkg;

/** @param {{ broadcast: (channel: string, data: unknown) => void, beforeInstall: () => void }} ctx */
export function initUpdater(ctx) {
    let state = { status: app.isPackaged ? "idle" : "disabled", current: app.getVersion() };
    const set = (patch) => {
        state = { ...state, ...patch };
        ctx.broadcast("update:state", state);
        return state;
    };

    autoUpdater.autoDownload = false;
    autoUpdater.autoInstallOnAppQuit = true;
    autoUpdater.allowPrerelease = false;
    autoUpdater.logger = null;

    let downloading = false;
    // во время скачивания повторная проверка (между попытками) не меняет состояние на экране
    autoUpdater.on("checking-for-update", () => !downloading && set({ status: "checking", error: undefined }));
    autoUpdater.on("update-available", (i) => !downloading && set({ status: "available", version: i.version }));
    autoUpdater.on("update-not-available", () => set({ status: "none" }));
    autoUpdater.on("download-progress", (p) => set({ status: "downloading", progress: Math.round(p.percent) }));
    autoUpdater.on("update-downloaded", (i) => set({ status: "ready", version: i.version, progress: 100 }));
    autoUpdater.on("error", (e) => !downloading && set({ status: "error", error: String(e?.message ?? e).split("\n")[0] }));

    async function check() {
        if (!app.isPackaged) return set({ status: "disabled" });
        if (state.status === "downloading" || state.status === "ready") return state;
        try {
            await autoUpdater.checkForUpdates();
        } catch {
            /* состояние уже выставлено обработчиком error */
        }
        return state;
    }

    ctx.handle("update:get", ["main"], () => state);
    ctx.handle("update:check", ["main"], () => check());
    ctx.handle("update:download", ["main"], async () => {
        if (state.status !== "available" || downloading) return;
        downloading = true;
        set({ status: "downloading", progress: 0, error: undefined });
        let lastErr = "";
        // обрывы соединения бывают (прокси, нестабильная сеть) — до 4 попыток
        for (let attempt = 1; attempt <= 4; attempt++) {
            try {
                if (attempt > 1) await autoUpdater.checkForUpdates();
                await autoUpdater.downloadUpdate();
                downloading = false;
                return; // дальше — событие update-downloaded
            } catch (e) {
                lastErr = String(e?.message ?? e).split("\n")[0];
                await new Promise((res) => setTimeout(res, 3000 * attempt));
            }
        }
        downloading = false;
        // кнопка «Скачать» остаётся — можно попробовать ещё раз
        set({ status: "available", progress: undefined, error: `не удалось скачать: ${lastErr}` });
    });
    function install() {
        if (state.status !== "ready") return;
        ctx.beforeInstall();
        // тихая установка поверх и перезапуск
        setImmediate(() => autoUpdater.quitAndInstall(true, true));
    }
    ctx.handle("update:install", ["main"], () => install());

    // проверка при запуске и раз в 6 часов — только проверка, скачивание по кнопке
    if (app.isPackaged) {
        setTimeout(check, 8000);
        setInterval(check, 6 * 3600_000);
    }

    return { check, install, get: () => state };
}
