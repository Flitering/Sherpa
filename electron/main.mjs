// Sherpa — десктоп-приложение (Electron).
//
// Что делает основной процесс:
//  - безрамочное главное окно и прозрачный виджет поверх игры (всегда сверху, двигается,
//    меняет размер, может пропускать клики сквозь себя);
//  - сам находит папки скриншотов и логов игры (как TarkovMonitor) и даёт интерфейсу
//    читать из них файлы — только чтение и только внутри этих папок;
//  - скачивает свежие данные tarkov.dev в папку пользователя;
//  - глобальные сочетания клавиш для виджета;
//  - значок в трее (скрытые значки), обновление по кнопке, цена предмета по наведению.
//
// С процессом игры приложение не взаимодействует: не читает память, не внедряется,
// не нажимает клавиши. Сочетания клавиш регистрируются в Windows, а не в игре.

import { app, BrowserWindow, dialog, globalShortcut, ipcMain, Menu, net, Notification, protocol, shell, screen, Tray } from "electron";
import { execFile } from "node:child_process";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { initPriceCheck } from "./pricecheck.mjs";
import { styleMaps } from "./stylemaps.mjs";
import { initUpdater } from "./updater.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, "..");
const DEV_URL = process.env.SHERPA_DEV_URL; // npm run desktop:dev
const DIST = path.join(ROOT, "dist");
const PUBLIC = path.join(ROOT, "public");
// отдельный профиль (для автотестов и второй копии приложения)
if (process.env.SHERPA_USER_DIR) app.setPath("userData", process.env.SHERPA_USER_DIR);
const USER = app.getPath("userData");
const USER_DATA = path.join(USER, "content"); // свежие данные tarkov.dev: data/*.json, maps/svg/*.svg
const SETTINGS_FILE = path.join(USER, "settings.json");

app.setAppUserModelId("app.sherpa.tarkov");

// одна копия приложения: повторный запуск просто показывает окно
if (!app.requestSingleInstanceLock()) {
    app.quit();
    process.exit(0);
}
app.on("second-instance", () => showMain());

const ICON = path.join(HERE, "assets", process.platform === "win32" ? "icon.ico" : "icon.png");
let quitting = false;
app.on("before-quit", () => (quitting = true));

// ---------------- настройки (окна, папки, виджет) ----------------

let settings = {
    main: { width: 1440, height: 900 },
    overlay: { width: 420, height: 640, opacity: 0.6, clickThrough: false },
    paths: { screenshots: null, logs: null },
    prefs: { closeToTray: true },
};
try {
    const saved = JSON.parse(fs.readFileSync(SETTINGS_FILE, "utf8"));
    for (const k of Object.keys(saved)) settings[k] = settings[k] && typeof settings[k] === "object" ? { ...settings[k], ...saved[k] } : saved[k];
} catch {
    /* первый запуск */
}
let saveTimer = null;
function saveSettings() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => fsp.mkdir(USER, { recursive: true }).then(() => fsp.writeFile(SETTINGS_FILE, JSON.stringify(settings, null, 2))).catch(() => {}), 400);
}

// ---------------- протокол app:// — интерфейс и данные ----------------

protocol.registerSchemesAsPrivileged([{ scheme: "app", privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true } }]);

const MIME = {
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript",
    ".mjs": "text/javascript",
    ".css": "text/css",
    ".json": "application/json",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".webp": "image/webp",
    ".woff2": "font/woff2",
    ".woff": "font/woff",
    ".ico": "image/x-icon",
    ".wasm": "application/wasm",
};

/** Безопасно: путь только внутри base. */
function inside(base, rel) {
    const p = path.resolve(base, rel);
    return p === base || p.startsWith(base + path.sep) ? p : null;
}

function registerAppProtocol() {
    protocol.handle("app", async (req) => {
        const url = new URL(req.url);
        let rel = decodeURIComponent(url.pathname).replace(/^\/+/, "") || "index.html";
        // данные и карты: сначала свежая копия пользователя, затем то, что пришло с приложением
        const bases = rel.startsWith("data/") || rel.startsWith("maps/") ? [USER_DATA, DIST, PUBLIC] : [DIST];
        for (const base of bases) {
            const file = inside(base, rel);
            if (!file) continue;
            try {
                const buf = await fsp.readFile(file);
                return new Response(buf, {
                    headers: { "content-type": MIME[path.extname(file).toLowerCase()] ?? "application/octet-stream", "access-control-allow-origin": "*", "cache-control": "no-cache" },
                });
            } catch {
                /* следующий вариант */
            }
        }
        return new Response("not found", { status: 404 });
    });
}

// ---------------- поиск папок игры ----------------

function regQuery(key, value) {
    return new Promise((resolve) => {
        execFile("reg", ["query", key, "/v", value], { windowsHide: true }, (err, out) => {
            if (err) return resolve(null);
            const m = new RegExp(`${value}\\s+REG_\\w+\\s+(.+)`).exec(out);
            resolve(m ? m[1].trim() : null);
        });
    });
}

const exists = (p) => !!p && fs.existsSync(p);

async function detectLogs() {
    const installs = new Set();
    const keys = [
        "SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\EscapeFromTarkov",
        "SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\EscapeFromTarkov",
        "SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\Steam App 3932890",
        "SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\Steam App 3932890",
    ];
    for (const hive of ["HKLM", "HKCU"]) for (const k of keys) {
        const v = await regQuery(`${hive}\\${k}`, "InstallLocation");
        if (v) installs.add(v);
    }
    // Steam: библиотеки из libraryfolders.vdf
    for (const k of ["HKCU\\Software\\Valve\\Steam", "HKLM\\SOFTWARE\\WOW6432Node\\Valve\\Steam", "HKLM\\SOFTWARE\\Valve\\Steam"]) {
        for (const v of ["SteamPath", "InstallPath"]) {
            const root = await regQuery(k, v);
            if (!exists(root)) continue;
            const libs = new Set([root]);
            try {
                const vdf = await fsp.readFile(path.join(root, "steamapps", "libraryfolders.vdf"), "utf8");
                for (const m of vdf.matchAll(/"path"\s+"([^"]+)"/gi)) libs.add(m[1].replace(/\\\\/g, "\\"));
            } catch {
                /* нет файла */
            }
            for (const lib of libs) installs.add(path.join(lib, "steamapps", "common", "Escape from Tarkov"));
        }
    }
    // частые места установки
    for (const d of ["C", "D", "E", "F"]) installs.add(`${d}:\\Battlestate Games\\Escape from Tarkov`), installs.add(`${d}:\\Battlestate Games\\EFT`);
    for (const inst of installs) for (const sub of ["Logs", path.join("build", "Logs")]) {
        const p = path.join(inst, sub);
        if (exists(p)) return p;
    }
    return null;
}

function detectScreenshots() {
    const docs = app.getPath("documents");
    for (const name of ["Escape From Tarkov", "Escape from Tarkov"]) {
        const p = path.join(docs, name, "Screenshots");
        if (exists(p)) return p;
    }
    return null;
}

/** Клавиша скриншота из настроек управления игры (если удастся прочитать). */
async function detectScreenshotKey() {
    const dir = path.join(app.getPath("appData"), "Battlestate Games", "Escape from Tarkov", "Settings");
    try {
        const text = await fsp.readFile(path.join(dir, "Control.ini"), "utf8");
        const json = JSON.parse(text);
        const binds = json.keyBindings ?? json.KeyBindings ?? [];
        const b = binds.find((x) => /screenshot/i.test(x.keyName ?? x.KeyName ?? ""));
        const variant = (b?.variants ?? b?.Variants ?? []).find((v) => (v.keyCode ?? v.KeyCode ?? []).length);
        const codes = variant ? variant.keyCode ?? variant.KeyCode : null;
        if (!codes?.length) return null;
        const pretty = { SysReq: "Print Screen", Print: "Print Screen", LeftControl: "Ctrl", RightControl: "Ctrl", LeftShift: "Shift", RightShift: "Shift", LeftAlt: "Alt", RightAlt: "Alt" };
        return codes.map((c) => pretty[c] ?? c).join(" + ");
    } catch {
        return null;
    }
}

async function resolvePaths() {
    const shots = settings.paths.screenshots && exists(settings.paths.screenshots) ? settings.paths.screenshots : detectScreenshots();
    const logs = settings.paths.logs && exists(settings.paths.logs) ? settings.paths.logs : await detectLogs();
    return { screenshots: shots, logs, screenshotsAuto: !settings.paths.screenshots, logsAuto: !settings.paths.logs };
}

// чтение файлов — только внутри разрешённых папок
const allowedRoots = new Set();
async function refreshRoots() {
    const p = await resolvePaths();
    allowedRoots.clear();
    for (const r of [p.screenshots, p.logs]) if (r) allowedRoots.add(path.resolve(r));
    return p;
}
function checkAllowed(p) {
    const abs = path.resolve(p);
    for (const r of allowedRoots) if (abs === r || abs.startsWith(r + path.sep)) return abs;
    throw new Error("Доступ только к папкам скриншотов и логов игры");
}

// ---------------- окна ----------------

let mainWin = null;
let overlayWin = null;

const preload = path.join(HERE, "preload.cjs");
const pageUrl = (page) => (DEV_URL ? `${DEV_URL}/${page}` : `app://app/${page}`);

function createMain() {
    const b = settings.main;
    mainWin = new BrowserWindow({
        x: b.x,
        y: b.y,
        width: b.width,
        height: b.height,
        minWidth: 1100,
        minHeight: 680,
        frame: false,
        backgroundColor: "#090a09",
        show: false,
        title: "Sherpa",
        icon: ICON,
        webPreferences: { preload, contextIsolation: true, sandbox: true },
    });
    if (b.maximized) mainWin.maximize();
    mainWin.once("ready-to-show", () => mainWin.show());
    mainWin.loadURL(pageUrl("index.html"));
    const remember = () => {
        if (!mainWin) return;
        settings.main = { ...mainWin.getNormalBounds(), maximized: mainWin.isMaximized() };
        saveSettings();
        mainWin.webContents.send("win:state", { maximized: mainWin.isMaximized() });
    };
    mainWin.on("resize", remember);
    mainWin.on("move", remember);
    mainWin.on("maximize", remember);
    mainWin.on("unmaximize", remember);
    mainWin.on("close", (e) => {
        if (quitting || !settings.prefs.closeToTray) return;
        // приложение остаётся в трее: ловит начало рейда и цены по наведению
        e.preventDefault();
        mainWin.hide();
        if (!settings.trayHintShown && Notification.isSupported()) {
            settings.trayHintShown = true;
            saveSettings();
            new Notification({ title: "Sherpa работает в фоне", body: "Значок — в скрытых значках у часов. Выход — правой кнопкой по значку.", icon: ICON }).show();
        }
    });
    mainWin.on("closed", () => {
        mainWin = null;
        overlayWin?.close();
        app.quit();
    });
    // внешние ссылки — в обычном браузере
    mainWin.webContents.setWindowOpenHandler(({ url }) => {
        if (/^https?:/.test(url)) shell.openExternal(url);
        return { action: "deny" };
    });
}

function fitOnScreen(b) {
    const area = screen.getDisplayMatching({ x: b.x ?? 0, y: b.y ?? 0, width: b.width, height: b.height }).workArea;
    const x = b.x == null ? area.x + area.width - b.width - 24 : Math.min(Math.max(b.x, area.x), area.x + area.width - 80);
    const y = b.y == null ? area.y + 80 : Math.min(Math.max(b.y, area.y), area.y + area.height - 80);
    return { ...b, x, y };
}

function createOverlay() {
    if (overlayWin) {
        overlayWin.showInactive();
        return overlayWin;
    }
    const b = fitOnScreen(settings.overlay);
    overlayWin = new BrowserWindow({
        x: b.x,
        y: b.y,
        width: b.width,
        height: b.height,
        minWidth: 240,
        minHeight: 180,
        frame: false,
        transparent: true,
        backgroundColor: "#00000000",
        hasShadow: false,
        resizable: true,
        alwaysOnTop: true,
        skipTaskbar: true,
        show: false,
        title: "Sherpa — навигатор",
        webPreferences: { preload, contextIsolation: true, sandbox: true, backgroundThrottling: false },
    });
    overlayWin.setAlwaysOnTop(true, "screen-saver");
    overlayWin.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
    overlayWin.loadURL(pageUrl("overlay.html"));
    overlayWin.once("ready-to-show", () => {
        overlayWin.showInactive(); // не забираем фокус у игры
        applyClickThrough();
        sendOverlayState();
        if (lastModel) overlayWin.webContents.send("overlay:model", lastModel);
    });
    const remember = () => {
        if (!overlayWin) return;
        settings.overlay = { ...settings.overlay, ...overlayWin.getBounds() };
        saveSettings();
    };
    overlayWin.on("resize", remember);
    overlayWin.on("move", remember);
    overlayWin.on("closed", () => {
        overlayWin = null;
        mainWin?.webContents.send("overlay:closed");
    });
    return overlayWin;
}

function applyClickThrough() {
    if (!overlayWin) return;
    const on = !!settings.overlay.clickThrough;
    overlayWin.setIgnoreMouseEvents(on, { forward: true });
}

function sendOverlayState() {
    const s = { opacity: settings.overlay.opacity, clickThrough: !!settings.overlay.clickThrough, open: !!overlayWin };
    overlayWin?.webContents.send("overlay:state", s);
    mainWin?.webContents.send("overlay:state", s);
}

let lastModel = null;

function showMain() {
    if (!mainWin) return createMain();
    if (mainWin.isMinimized()) mainWin.restore();
    mainWin.show();
    mainWin.focus();
}

// ---------------- трей ----------------

let tray = null;
let price = null;
let updater = null;

function trayMenu() {
    const up = updater?.get();
    const upLabel =
        up?.status === "ready" ? `Установить обновление ${up.version}` : up?.status === "available" ? `Скачать обновление ${up.version}` : "Проверить обновления";
    return Menu.buildFromTemplate([
        { label: "Открыть Sherpa", click: showMain },
        { label: overlayWin?.isVisible() ? "Скрыть виджет" : "Показать виджет", click: () => HOTKEYS["CommandOrControl+Shift+N"]() },
        {
            label: "Цена по наведению",
            type: "checkbox",
            checked: !!price?.isEnabled(),
            click: () => price?.toggle(),
        },
        { type: "separator" },
        {
            label: upLabel,
            enabled: !!app.isPackaged && up?.status !== "checking" && up?.status !== "downloading",
            click: async () => {
                showMain();
                if (up?.status === "ready") updater?.install();
                else await updater?.check();
            },
        },
        { type: "separator" },
        {
            label: "Выход",
            click: () => {
                quitting = true;
                app.quit();
            },
        },
    ]);
}

function createTray() {
    tray = new Tray(ICON);
    tray.setToolTip(`Sherpa ${app.getVersion()}`);
    tray.on("click", showMain);
    tray.on("double-click", showMain);
    // меню собирается при каждом открытии — галочки и подписи всегда актуальны
    tray.on("right-click", () => tray.popUpContextMenu(trayMenu()));
}

function broadcast(channel, data) {
    for (const w of BrowserWindow.getAllWindows()) w.webContents.send(channel, data);
}

// ---------------- IPC ----------------

function registerIpc() {
    // окно
    ipcMain.handle("win:minimize", (e) => BrowserWindow.fromWebContents(e.sender)?.minimize());
    ipcMain.handle("win:toggleMaximize", (e) => {
        const w = BrowserWindow.fromWebContents(e.sender);
        if (!w) return;
        if (w.isMaximized()) w.unmaximize();
        else w.maximize();
    });
    ipcMain.handle("win:close", (e) => BrowserWindow.fromWebContents(e.sender)?.close());
    ipcMain.handle("win:isMaximized", (e) => !!BrowserWindow.fromWebContents(e.sender)?.isMaximized());
    ipcMain.handle("app:info", () => ({ version: app.getVersion(), userData: USER, content: USER_DATA, dev: !!DEV_URL }));
    ipcMain.handle("app:prefs", () => settings.prefs);
    ipcMain.handle("app:setPrefs", (_e, patch) => {
        settings.prefs = { ...settings.prefs, ...patch };
        saveSettings();
        return settings.prefs;
    });
    ipcMain.handle("shell:open", (_e, url) => (/^https?:/.test(url) ? shell.openExternal(url) : null));
    ipcMain.handle("shell:showFolder", (_e, p) => (p && exists(p) ? shell.openPath(p) : null));

    // папки игры
    ipcMain.handle("paths:get", () => refreshRoots());
    ipcMain.handle("paths:pick", async (e, kind) => {
        const r = await dialog.showOpenDialog(BrowserWindow.fromWebContents(e.sender), {
            title: kind === "logs" ? "Папка Logs игры" : "Папка скриншотов игры",
            properties: ["openDirectory"],
        });
        if (r.canceled || !r.filePaths[0]) return refreshRoots();
        settings.paths[kind === "logs" ? "logs" : "screenshots"] = r.filePaths[0];
        saveSettings();
        return refreshRoots();
    });
    ipcMain.handle("paths:reset", (_e, kind) => {
        settings.paths[kind === "logs" ? "logs" : "screenshots"] = null;
        saveSettings();
        return refreshRoots();
    });
    ipcMain.handle("game:screenshotKey", () => detectScreenshotKey());

    // чтение файлов в папках игры
    ipcMain.handle("fs:list", async (_e, dir) => {
        const abs = checkAllowed(dir);
        const ents = await fsp.readdir(abs, { withFileTypes: true });
        return ents.map((d) => ({ name: d.name, kind: d.isDirectory() ? "directory" : "file" }));
    });
    ipcMain.handle("fs:stat", async (_e, file) => {
        const st = await fsp.stat(checkAllowed(file));
        return { size: st.size, mtimeMs: st.mtimeMs };
    });
    ipcMain.handle("fs:readText", async (_e, file, start, end) => {
        const abs = checkAllowed(file);
        if (start == null) return fsp.readFile(abs, "utf8");
        const fh = await fsp.open(abs, "r");
        try {
            const len = Math.max(0, (end ?? (await fh.stat()).size) - start);
            const buf = Buffer.alloc(len);
            await fh.read(buf, 0, len, start);
            return buf.toString("utf8");
        } finally {
            await fh.close();
        }
    });
    ipcMain.handle("fs:readBytes", async (_e, file) => {
        const buf = await fsp.readFile(checkAllowed(file));
        return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
    });

    // виджет
    ipcMain.handle("overlay:open", () => {
        createOverlay();
        sendOverlayState();
    });
    ipcMain.handle("overlay:close", () => overlayWin?.close());
    ipcMain.handle("overlay:set", (_e, patch) => {
        settings.overlay = { ...settings.overlay, ...patch };
        saveSettings();
        applyClickThrough();
        sendOverlayState();
    });
    ipcMain.handle("overlay:getState", () => ({ opacity: settings.overlay.opacity, clickThrough: !!settings.overlay.clickThrough, open: !!overlayWin }));
    ipcMain.on("overlay:model", (_e, model) => {
        lastModel = model;
        overlayWin?.webContents.send("overlay:model", model);
    });
    ipcMain.on("overlay:action", (_e, action) => {
        if (action?.type === "openMain") {
            if (mainWin?.isMinimized()) mainWin.restore();
            mainWin?.show();
            mainWin?.focus();
            return;
        }
        mainWin?.webContents.send("overlay:action", action);
    });
    // пока включён «сквозной» режим, наведение на ручку виджета временно возвращает клики
    ipcMain.on("overlay:hoverHandle", (_e, on) => {
        if (!overlayWin || !settings.overlay.clickThrough) return;
        overlayWin.setIgnoreMouseEvents(!on, { forward: true });
    });

    // данные tarkov.dev
    ipcMain.handle("data:sync", async (e, modes) => {
        const send = (m) => e.sender.send("data:progress", m);
        const { syncData } = await import(pathToFileURL(path.join(ROOT, "scripts", "sync-data.mjs")).href);
        await syncData({
            outData: path.join(USER_DATA, "data"),
            outSvg: path.join(USER_DATA, "maps", "svg"),
            modes,
            forceSvg: true,
            fetch: (url, init) => net.fetch(url, init), // сеть Chromium — как в браузере
            log: send,
        });
        // схемы растровых карт — по свежим данным
        await styleMaps({ dataDir: path.join(USER_DATA, "data"), outDir: path.join(USER_DATA, "maps", "styled"), seedDir: path.join(DIST, "maps", "styled"), fetch: (u) => net.fetch(u), log: send }).catch((err) =>
            send("Схемы карт: " + err.message),
        );
        settings.lastSync = Date.now();
        saveSettings();
        return settings.lastSync;
    });
    ipcMain.handle("data:info", () => ({ lastSync: settings.lastSync ?? null, hasUserData: exists(path.join(USER_DATA, "data", "regular.json")) }));
}

// ---------------- горячие клавиши ----------------

const HOTKEYS = {
    "CommandOrControl+Shift+N": () => {
        if (overlayWin?.isVisible()) overlayWin.hide();
        else createOverlay();
    },
    "CommandOrControl+Shift+L": () => {
        settings.overlay.clickThrough = !settings.overlay.clickThrough;
        saveSettings();
        applyClickThrough();
        sendOverlayState();
    },
    "CommandOrControl+Shift+D": () => mainWin?.webContents.send("overlay:action", { type: "done" }),
    "CommandOrControl+Shift+S": () => mainWin?.webContents.send("overlay:action", { type: "skip" }),
    "CommandOrControl+Shift+P": () => price?.scanNow(),
};

// ---------------- запуск ----------------

app.whenReady().then(async () => {
    registerAppProtocol();
    registerIpc();
    await refreshRoots();
    createMain();
    createTray();
    price = initPriceCheck({ settings, saveSettings, preload, pageUrl, userDir: USER, mainWin: () => mainWin });
    if (process.env.SHERPA_TEST) globalThis.__sherpa = { price, tray: () => tray };
    updater = initUpdater({
        broadcast,
        beforeInstall: () => {
            quitting = true;
            overlayWin?.destroy();
        },
    });
    for (const [acc, fn] of Object.entries(HOTKEYS)) {
        try {
            globalShortcut.register(acc, fn);
        } catch {
            /* сочетание занято другой программой */
        }
    }
});

app.on("will-quit", () => globalShortcut.unregisterAll());
app.on("window-all-closed", () => {
    if (quitting) app.quit();
});
