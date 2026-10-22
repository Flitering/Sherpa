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
import { CSP, hardenApp, openExternalSafe, originOf } from "./security.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, "..");
// dev-сервер — только при разработке: в собранном приложении переменная окружения не должна
// подменять интерфейс чужой страницей с доступом к мосту приложения
const DEV_URL = app.isPackaged ? undefined : process.env.SHERPA_DEV_URL; // npm run desktop:dev
const TEST = !app.isPackaged && !!process.env.SHERPA_TEST;
/** Откуда может быть интерфейс приложения. */
const TRUSTED_ORIGINS = [DEV_URL ? originOf(DEV_URL) : "app://app"];
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
        if (url.host !== "app") return new Response("not found", { status: 404 });
        let rel = decodeURIComponent(url.pathname).replace(/^\/+/, "") || "index.html";
        // данные и карты: сначала свежая копия пользователя, затем то, что пришло с приложением
        const bases = rel.startsWith("data/") || rel.startsWith("maps/") ? [USER_DATA, DIST, PUBLIC] : [DIST];
        for (const base of bases) {
            const file = inside(base, rel);
            if (!file) continue;
            try {
                const buf = await fsp.readFile(file);
                const ext = path.extname(file).toLowerCase();
                const headers = { "content-type": MIME[ext] ?? "application/octet-stream", "cache-control": "no-cache", "x-content-type-options": "nosniff" };
                if (ext === ".html") headers["content-security-policy"] = CSP;
                // данные читают и страницы dev-сервера (другой источник) — CORS только для них
                if (DEV_URL) headers["access-control-allow-origin"] = originOf(DEV_URL);
                return new Response(buf, { headers });
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
    // в версии 1.0 игра пишет в build\Logs, а в корне может остаться старая папка Logs —
    // берём ту, где самая свежая сессия игры
    let best = null;
    let bestTime = -1;
    for (const inst of installs)
        for (const sub of [path.join("build", "Logs"), "Logs"]) {
            const p = path.join(inst, sub);
            if (!exists(p)) continue;
            let newest = 0;
            try {
                for (const d of fs.readdirSync(p, { withFileTypes: true })) {
                    if (!d.isDirectory() || !d.name.startsWith("log_")) continue;
                    newest = Math.max(newest, fs.statSync(path.join(p, d.name)).mtimeMs);
                }
            } catch {
                /* нет доступа */
            }
            if (newest > bestTime) {
                best = p;
                bestTime = newest;
            }
        }
    return best;
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
    for (const r of [p.screenshots, p.logs]) if (r) allowedRoots.add(realOrResolved(r));
    return p;
}
function realOrResolved(p) {
    try {
        return fs.realpathSync.native(p);
    } catch {
        return path.resolve(p);
    }
}
function within(abs, roots) {
    const a = abs.toLowerCase();
    for (const r of roots) {
        const rr = r.toLowerCase();
        if (a === rr || a.startsWith(rr + path.sep)) return true;
    }
    return false;
}
function checkAllowed(p) {
    if (typeof p !== "string" || !p || p.length > 1024) throw new Error("Неверный путь");
    const abs = realOrResolved(p);
    if (within(abs, allowedRoots)) return abs;
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

/**
 * Запрос принимается, только если он пришёл из верхнего фрейма окна Sherpa с интерфейсом приложения
 * и это окно имеет право на этот канал: главное окно, виджет или карточка цены.
 */
function senderOk(e, roles) {
    const frame = e.senderFrame;
    if (!frame || frame !== e.sender.mainFrame) return false;
    if (!TRUSTED_ORIGINS.includes(originOf(frame.url))) return false;
    const w = BrowserWindow.fromWebContents(e.sender);
    const role = w && w === mainWin ? "main" : w && w === overlayWin ? "overlay" : w && w === price?.window() ? "price" : null;
    return !!role && roles.includes(role);
}
const MAIN = ["main"];
const UI = ["main", "overlay"];
function handle(channel, roles, fn) {
    ipcMain.handle(channel, (e, ...args) => {
        if (!senderOk(e, roles)) throw new Error("Запрос отклонён");
        return fn(e, ...args);
    });
}
function on(channel, roles, fn) {
    ipcMain.on(channel, (e, ...args) => {
        if (senderOk(e, roles)) fn(e, ...args);
    });
}
const bool = (v) => v === true;
const kindOf = (k) => (k === "logs" ? "logs" : "screenshots");

function registerIpc() {
    // окно
    handle("win:minimize", UI, (e) => BrowserWindow.fromWebContents(e.sender)?.minimize());
    handle("win:toggleMaximize", UI, (e) => {
        const w = BrowserWindow.fromWebContents(e.sender);
        if (!w) return;
        if (w.isMaximized()) w.unmaximize();
        else w.maximize();
    });
    handle("win:close", UI, (e) => BrowserWindow.fromWebContents(e.sender)?.close());
    handle("win:isMaximized", UI, (e) => !!BrowserWindow.fromWebContents(e.sender)?.isMaximized());
    handle("app:info", UI, () => ({ version: app.getVersion(), userData: USER, content: USER_DATA, dev: !!DEV_URL }));
    // прогресс игроков: копия в файле (основное хранилище интерфейса — localStorage в этой же папке)
    const PROGRESS = path.join(USER, "progress.json");
    const BACKUPS = path.join(USER, "backups");
    handle("store:load", MAIN, async () => {
        for (const p of [PROGRESS, PROGRESS + ".tmp"]) {
            try {
                return await fsp.readFile(p, "utf8");
            } catch {
                /* следующий вариант */
            }
        }
        return null;
    });
    handle("store:save", MAIN, async (_e, json) => {
        if (typeof json !== "string" || json.length > 20_000_000) return;
        await fsp.mkdir(BACKUPS, { recursive: true });
        // запись через временный файл: прогресс не побьётся, если компьютер выключится посреди записи
        await fsp.writeFile(PROGRESS + ".tmp", json);
        await fsp.rename(PROGRESS + ".tmp", PROGRESS);
        // копия на каждый день, хранятся 7 последних
        const day = new Date().toISOString().slice(0, 10);
        await fsp.writeFile(path.join(BACKUPS, `progress-${day}.json`), json);
        const old = (await fsp.readdir(BACKUPS)).filter((n) => n.startsWith("progress-")).sort().slice(0, -7);
        for (const n of old) await fsp.rm(path.join(BACKUPS, n), { force: true });
    });
    handle("app:prefs", MAIN, () => settings.prefs);
    handle("app:setPrefs", MAIN, (_e, patch) => {
        if (typeof patch?.closeToTray === "boolean") settings.prefs = { ...settings.prefs, closeToTray: patch.closeToTray };
        saveSettings();
        return settings.prefs;
    });
    handle("shell:open", UI, (_e, url) => openExternalSafe(String(url)));
    // открыть можно только папку приложения или папки игры — не файл (openPath запустил бы программу)
    handle("shell:showFolder", MAIN, async (_e, p) => {
        if (typeof p !== "string" || !p) return null;
        const abs = realOrResolved(p);
        if (!within(abs, [realOrResolved(USER), ...allowedRoots])) return null;
        const st = await fsp.stat(abs).catch(() => null);
        return st?.isDirectory() ? shell.openPath(abs) : null;
    });

    // папки игры
    handle("paths:get", MAIN, () => refreshRoots());
    handle("paths:pick", MAIN, async (e, kind) => {
        const r = await dialog.showOpenDialog(BrowserWindow.fromWebContents(e.sender), {
            title: kindOf(kind) === "logs" ? "Папка Logs игры" : "Папка скриншотов игры",
            properties: ["openDirectory"],
        });
        if (r.canceled || !r.filePaths[0]) return refreshRoots();
        settings.paths[kindOf(kind)] = r.filePaths[0];
        saveSettings();
        return refreshRoots();
    });
    handle("paths:reset", MAIN, (_e, kind) => {
        settings.paths[kindOf(kind)] = null;
        saveSettings();
        return refreshRoots();
    });
    handle("game:screenshotKey", MAIN, () => detectScreenshotKey());

    // чтение файлов в папках игры
    handle("fs:list", MAIN, async (_e, dir) => {
        const abs = checkAllowed(dir);
        const ents = await fsp.readdir(abs, { withFileTypes: true });
        return ents.map((d) => ({ name: d.name, kind: d.isDirectory() ? "directory" : "file" }));
    });
    handle("fs:stat", MAIN, async (_e, file) => {
        const st = await fsp.stat(checkAllowed(file));
        return { size: st.size, mtimeMs: st.mtimeMs };
    });
    handle("fs:readText", MAIN, async (_e, file, start, end) => {
        const abs = checkAllowed(file);
        const MAX = 64 * 1024 * 1024;
        if (start == null) {
            if ((await fsp.stat(abs)).size > MAX) throw new Error("Файл слишком большой");
            return fsp.readFile(abs, "utf8");
        }
        if (!Number.isSafeInteger(start) || start < 0 || (end != null && (!Number.isSafeInteger(end) || end < start))) throw new Error("Неверный диапазон");
        const fh = await fsp.open(abs, "r");
        try {
            const len = Math.min(MAX, Math.max(0, (end ?? (await fh.stat()).size) - start));
            const buf = Buffer.alloc(len);
            await fh.read(buf, 0, len, start);
            return buf.toString("utf8");
        } finally {
            await fh.close();
        }
    });
    handle("fs:readBytes", MAIN, async (_e, file) => {
        const abs = checkAllowed(file);
        if ((await fsp.stat(abs)).size > 64 * 1024 * 1024) throw new Error("Файл слишком большой");
        const buf = await fsp.readFile(abs);
        return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
    });

    // виджет
    handle("overlay:open", UI, () => {
        createOverlay();
        sendOverlayState();
    });
    handle("overlay:close", UI, () => overlayWin?.close());
    handle("overlay:set", UI, (_e, patch) => {
        // только эти два поля и только допустимые значения
        if (typeof patch?.opacity === "number" && Number.isFinite(patch.opacity)) settings.overlay.opacity = Math.min(1, Math.max(0.1, patch.opacity));
        if (typeof patch?.clickThrough === "boolean") settings.overlay.clickThrough = patch.clickThrough;
        saveSettings();
        applyClickThrough();
        sendOverlayState();
    });
    handle("overlay:getState", UI, () => ({ opacity: settings.overlay.opacity, clickThrough: !!settings.overlay.clickThrough, open: !!overlayWin }));
    on("overlay:model", MAIN, (_e, model) => {
        lastModel = model;
        overlayWin?.webContents.send("overlay:model", model);
    });
    on("overlay:action", ["overlay"], (_e, action) => {
        if (action?.type === "openMain") {
            if (mainWin?.isMinimized()) mainWin.restore();
            mainWin?.show();
            mainWin?.focus();
            return;
        }
        mainWin?.webContents.send("overlay:action", action);
    });
    // пока включён «сквозной» режим, наведение на ручку виджета временно возвращает клики
    on("overlay:hoverHandle", ["overlay"], (_e, over) => {
        if (!overlayWin || !settings.overlay.clickThrough) return;
        overlayWin.setIgnoreMouseEvents(!bool(over), { forward: true });
    });

    // данные tarkov.dev
    let syncing = null;
    handle("data:sync", MAIN, async (e, modes) => {
        // одно обновление за раз; режимы — только известные
        if (syncing) return syncing;
        modes = Array.isArray(modes) ? modes.filter((m) => m === "regular" || m === "pve") : undefined;
        syncing = runSync(e, modes).finally(() => (syncing = null));
        return syncing;
    });
    async function runSync(e, modes) {
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
    }
    handle("data:info", MAIN, () => ({ lastSync: settings.lastSync ?? null, hasUserData: exists(path.join(USER_DATA, "data", "regular.json")) }));
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
    hardenApp({ trustedOrigins: TRUSTED_ORIGINS });
    registerAppProtocol();
    registerIpc();
    await refreshRoots();
    createMain();
    createTray();
    price = initPriceCheck({ settings, saveSettings, preload, pageUrl, userDir: USER, mainWin: () => mainWin, handle, on });
    if (TEST) globalThis.__sherpa = { price, tray: () => tray };
    updater = initUpdater({
        handle,
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
