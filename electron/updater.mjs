// Обновление по кнопке: проверка релизов на GitHub, скачивание только изменившихся частей
// (blockmap), установка поверх в ту же папку, которую пользователь выбрал при установке.

import { app, ipcMain } from "electron";
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

    autoUpdater.on("checking-for-update", () => set({ status: "checking", error: undefined }));
    autoUpdater.on("update-available", (i) => set({ status: "available", version: i.version }));
    autoUpdater.on("update-not-available", () => set({ status: "none" }));
    autoUpdater.on("download-progress", (p) => set({ status: "downloading", progress: Math.round(p.percent) }));
    autoUpdater.on("update-downloaded", (i) => set({ status: "ready", version: i.version, progress: 100 }));
    autoUpdater.on("error", (e) => set({ status: "error", error: String(e?.message ?? e).split("\n")[0] }));

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

    ipcMain.handle("update:get", () => state);
    ipcMain.handle("update:check", () => check());
    ipcMain.handle("update:download", async () => {
        if (state.status !== "available") return;
        set({ status: "downloading", progress: 0 });
        try {
            await autoUpdater.downloadUpdate();
        } catch {
            /* см. error */
        }
    });
    function install() {
        if (state.status !== "ready") return;
        ctx.beforeInstall();
        // тихая установка поверх и перезапуск
        setImmediate(() => autoUpdater.quitAndInstall(true, true));
    }
    ipcMain.handle("update:install", () => install());

    // проверка при запуске и раз в 6 часов — только проверка, скачивание по кнопке
    if (app.isPackaged) {
        setTimeout(check, 8000);
        setInterval(check, 6 * 3600_000);
    }

    return { check, install, get: () => state };
}
