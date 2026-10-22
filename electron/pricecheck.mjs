// Цена предмета по наведению — как в Blitz и RatScanner, но своими силами.
//
// Как это устроено и почему это безопасно:
//  - положение курсора просто опрашивается (как любой программе, рисующей подсказки), без перехвата мыши;
//  - когда курсор замер, окно цены берёт кадр экрана тем же способом, что OBS или Discord при трансляции,
//    вырезает область у курсора и читает название из всплывающей подсказки игры;
//  - игра ничего об этом не знает: ни память, ни процесс, ни ввод не затрагиваются.
// Сканирование включается, только пока запущена игра (по списку процессов Windows), если не выбрано иное.

import { app, BrowserWindow, desktopCapturer, screen, session, shell } from "electron";
import { execFile, spawn } from "node:child_process";
import fsp from "node:fs/promises";
import path from "node:path";

const DWELL_MS = 280; // сколько курсор должен постоять
const RETRY_MS = 350; // подсказка игры появляется не сразу — пробуем ещё
const MAX_TRIES = 6; // ~2 секунды: без подсказки попытка дешёвая, распознавание не запускается
// увёл курсор — карточка исчезает (в автотестах настоящий курсор где угодно — не прячем)
const HIDE_DIST = !app.isPackaged && process.env.SHERPA_TEST ? Infinity : 36;

/**
 * @param {{ settings: any, saveSettings: () => void, preload: string, pageUrl: (p: string) => string, userDir: string, mainWin: () => BrowserWindow | null }} ctx
 */
export function initPriceCheck(ctx) {
    const st = () => (ctx.settings.price = { enabled: false, auto: true, onlyWithGame: true, debug: false, ...ctx.settings.price });
    st();
    const debugDir = path.join(ctx.userDir, "debug");

    let win = null;
    let ready = false;
    let timer = null;
    let gameTimer = null;
    let gameRunning = false;
    let last = { x: -1, y: -1, t: 0 }; // где курсор и с какого момента стоит
    let scan = null; // { x, y, t, tries, busy }
    let shownAt = null;
    let hideTimer = null;
    let targetDisplay = null;
    let lastName;

    // активное окно (кто сейчас на переднем плане): сканируем, только когда это игра
    let foreground = "";
    let fgProc = null;
    const active = () => st().enabled && (!st().onlyWithGame || (gameRunning && (fgProc ? /^EscapeFromTarkov$/i.test(foreground) : true)));
    const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

    function state() {
        return { ...st(), gameRunning, foreground, last: lastName };
    }
    function sendState() {
        ctx.mainWin()?.webContents.send("price:state", state());
    }

    // ---------------- окно-карточка ----------------

    function createWin() {
        if (win) return;
        ready = false;
        win = new BrowserWindow({
            width: 260,
            height: 120,
            show: false,
            frame: false,
            transparent: true,
            backgroundColor: "#00000000",
            hasShadow: false,
            resizable: false,
            focusable: false,
            skipTaskbar: true,
            alwaysOnTop: true,
            title: "Sherpa — цена",
            webPreferences: { preload: ctx.preload, contextIsolation: true, sandbox: true, backgroundThrottling: false },
        });
        win.setAlwaysOnTop(true, "screen-saver");
        win.setIgnoreMouseEvents(true);
        // защиту от захвата (setContentProtection) не ставим: у прозрачных окон Windows с ней может не рисовать
        // окно вовсе. Карточка стоит под подсказкой и исчезает, когда курсор уходит, — распознаванию не мешает.
        win.loadURL(ctx.pageUrl("price.html"));
        win.webContents.once("did-finish-load", () => (ready = true));
        win.on("closed", () => {
            win = null;
            ready = false;
        });
    }

    function hide() {
        clearTimeout(hideTimer);
        shownAt = null;
        if (win?.isVisible()) win.hide();
    }

    function show(res, at) {
        if (!win) return;
        const d = screen.getDisplayNearestPoint(at).workArea;
        const w = Math.max(60, res.width);
        const h = Math.max(30, res.height);
        // под подсказкой игры, по её левому краю; не влезает — над ней
        const tip = res.tip ?? { x: at.x + 14, y: at.y + 14, w: 0, h: 0 };
        let x = Math.round(tip.x);
        let y = Math.round(tip.y + tip.h + 4);
        if (y + h > d.y + d.height) y = Math.round(tip.y - h - 4);
        x = Math.min(Math.max(x, d.x), d.x + d.width - w);
        y = Math.min(Math.max(y, d.y), d.y + d.height - h);
        win.setBounds({ x, y, width: w, height: h });
        win.showInactive();
        shownAt = { x: at.x, y: at.y };
        clearTimeout(hideTimer);
        hideTimer = setTimeout(hide, res.found ? 12_000 : 1800);
    }

    /** Курсор над окном Sherpa — сканировать нечего. */
    function overOwnWindow(p) {
        for (const w of BrowserWindow.getAllWindows()) {
            if (w === win || !w.isVisible() || w.isMinimized()) continue;
            const b = w.getBounds();
            if (p.x >= b.x && p.x < b.x + b.width && p.y >= b.y && p.y < b.y + b.height) return true;
        }
        return false;
    }

    // ---------------- распознавание ----------------

    function request(p, manual) {
        if (!win || !ready) return false;
        const d = screen.getDisplayNearestPoint(p);
        targetDisplay = d.id;
        scan = { x: p.x, y: p.y, t: Date.now(), tries: (scan && dist(scan, p) < 6 ? scan.tries : 0) + 1, busy: true, manual };
        win.webContents.send("price:scan", {
            x: p.x,
            y: p.y,
            manual,
            debug: !!st().debug,
            display: { id: d.id, bounds: d.bounds, scaleFactor: d.scaleFactor },
        });
        // страховка, если ответ потерялся
        const s = scan;
        setTimeout(() => {
            if (scan === s && s.busy) s.busy = false;
        }, 4000);
        return true;
    }

    let previewUntil = 0;
    function tick() {
        if (Date.now() < previewUntil) return; // пробная карточка видна 5 секунд при любом окне
        if (!active()) return hide();
        const p = screen.getCursorScreenPoint();
        const now = Date.now();
        if (dist(p, last) > 3) last = { x: p.x, y: p.y, t: now };
        if (shownAt && dist(p, shownAt) > HIDE_DIST) hide();
        if (!st().auto || scan?.busy) return;
        if (now - last.t < DWELL_MS) return;
        if (scan && dist(scan, p) < 6 && (scan.tries >= MAX_TRIES || now - scan.t < RETRY_MS)) return;
        if (overOwnWindow(p)) return;
        request(p, false);
    }

    ctx.on("price:result", ["price"], (_e, res) => {
        if (!scan || typeof res !== "object" || !res) return;
        // размеры и координаты — только разумные числа (окно всегда поверх всего)
        const num = (v, lo, hi) => (typeof v === "number" && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : lo);
        res = {
            found: res.found === true,
            width: num(res.width, 0, 520),
            height: num(res.height, 0, 420),
            tip: res.tip && typeof res.tip === "object" ? { x: num(res.tip.x, -1e5, 1e5), y: num(res.tip.y, -1e5, 1e5), w: num(res.tip.w, 0, 4000), h: num(res.tip.h, 0, 4000) } : null,
            name: typeof res.name === "string" ? res.name.slice(0, 200) : undefined,
            error: typeof res.error === "string" ? res.error.slice(0, 300) : undefined,
        };
        if (scan.test) {
            // автотест по картинке: на экран ничего не выводим
            scan.busy = false;
            return;
        }
        const at = { x: scan.x, y: scan.y };
        const manual = scan.manual;
        scan.busy = false;
        if (scan.preview) {
            // пробная карточка: 5 секунд, курсор может уходить
            show({ ...res, tip: { x: at.x - res.width / 2, y: at.y - res.height / 2, w: 0, h: 0 } }, at);
            shownAt = null;
            previewUntil = Date.now() + 5000;
            clearTimeout(hideTimer);
            hideTimer = setTimeout(hide, 5000);
            return;
        }
        if (res.found) {
            scan.tries = MAX_TRIES; // нашли — по этой точке больше не сканируем
            lastName = res.name;
            sendState();
        }
        if (res.error) console.warn("price:", res.error);
        // курсор за это время ушёл — показывать поздно
        if (!manual && dist(screen.getCursorScreenPoint(), at) > HIDE_DIST) return;
        if (res.found || (manual && res.width)) show(res, at);
    });

    ctx.on("price:debug", ["price"], async (_e, d) => {
        if (!st().debug || typeof d?.png !== "string" || d.png.length > 15_000_000) return;
        try {
            await fsp.mkdir(debugDir, { recursive: true });
            const stamp = new Date().toISOString().replace(/[:.]/g, "-");
            await fsp.writeFile(path.join(debugDir, `${stamp}.png`), Buffer.from(String(d.png).split(",")[1] ?? "", "base64"));
            await fsp.writeFile(path.join(debugDir, `${stamp}.json`), JSON.stringify({ text: d.text, box: d.box, item: d.item, score: d.score }, null, 2));
            // храним последние 40 кадров
            const files = (await fsp.readdir(debugDir)).filter((f) => f.endsWith(".png")).sort();
            for (const f of files.slice(0, Math.max(0, files.length - 40))) {
                await fsp.rm(path.join(debugDir, f), { force: true });
                await fsp.rm(path.join(debugDir, f.replace(/\.png$/, ".json")), { force: true });
            }
        } catch {
            /* отладка не должна мешать */
        }
    });

    // захват экрана: без окна выбора — монитор под курсором (для окна цены — тот, где было наведение)
    session.defaultSession.setDisplayMediaRequestHandler(async (req, callback) => {
        try {
            const sources = await desktopCapturer.getSources({ types: ["screen"], thumbnailSize: { width: 0, height: 0 } });
            const fromPrice = !!win && req.frame && win.webContents.mainFrame === req.frame;
            let id = fromPrice ? targetDisplay : null;
            if (id == null) {
                // снимок из главного окна: игра обычно на другом мониторе, чем Sherpa
                const displays = screen.getAllDisplays();
                const mw = ctx.mainWin();
                const mine = mw ? screen.getDisplayMatching(mw.getBounds()).id : null;
                id = (displays.find((d) => d.id !== mine) ?? displays[0]).id;
                if (displays.length === 1) id = displays[0].id;
            }
            callback({ video: sources.find((s) => s.display_id === String(id)) ?? sources[0] });
        } catch {
            callback({});
        }
    });

    // ---------------- запущена ли игра ----------------

    /**
     * Какая программа на переднем плане — стандартный вызов Windows GetForegroundWindow из PowerShell,
     * раз в полсекунды. С игрой это никак не взаимодействует. Если не удалось — проверка только по процессу.
     */
    function startForeground() {
        if (fgProc || process.platform !== "win32") return;
        const script = [
            "$ErrorActionPreference='SilentlyContinue'",
            "Add-Type -Namespace Sherpa -Name Fg -MemberDefinition '[DllImport(\"user32.dll\")] public static extern System.IntPtr GetForegroundWindow(); [DllImport(\"user32.dll\")] public static extern uint GetWindowThreadProcessId(System.IntPtr h, out uint p);'",
            "while ($true) { $p = 0; [void][Sherpa.Fg]::GetWindowThreadProcessId([Sherpa.Fg]::GetForegroundWindow(), [ref]$p); $n = (Get-Process -Id $p).ProcessName; [Console]::Out.WriteLine($n); [Console]::Out.Flush(); Start-Sleep -Milliseconds 500 }",
        ].join("; ");
        try {
            fgProc = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script], { windowsHide: true, stdio: ["ignore", "pipe", "ignore"] });
        } catch {
            fgProc = null;
            return;
        }
        let buf = "";
        fgProc.stdout.on("data", (d) => {
            buf += d.toString();
            const lines = buf.split(/\r?\n/);
            buf = lines.pop() ?? "";
            if (lines.length) foreground = lines[lines.length - 1].trim();
        });
        fgProc.on("exit", () => {
            fgProc = null;
            foreground = "";
        });
    }
    function stopForeground() {
        fgProc?.kill();
        fgProc = null;
        foreground = "";
    }

    function checkGame() {
        execFile("tasklist", ["/FI", "IMAGENAME eq EscapeFromTarkov.exe", "/NH", "/FO", "CSV"], { windowsHide: true }, (err, out) => {
            const run = !err && /EscapeFromTarkov\.exe/i.test(out);
            if (run !== gameRunning) {
                gameRunning = run;
                sendState();
            }
        });
    }

    // ---------------- включение ----------------

    function apply() {
        const on = st().enabled;
        if (on) {
            createWin();
            if (!timer) timer = setInterval(tick, 100);
            if (!gameTimer) {
                checkGame();
                gameTimer = setInterval(checkGame, 8000);
            }
            if (st().onlyWithGame) startForeground();
            else stopForeground();
        } else {
            clearInterval(timer);
            clearInterval(gameTimer);
            timer = gameTimer = null;
            stopForeground();
            hide();
            win?.destroy();
        }
        sendState();
    }

    ctx.handle("price:get", ["main"], () => state());
    ctx.handle("price:set", ["main"], (_e, patch) => {
        for (const k of ["enabled", "auto", "onlyWithGame", "debug"]) if (typeof patch?.[k] === "boolean") st()[k] = patch[k];
        ctx.saveSettings();
        apply();
        return state();
    });
    // пробная карточка в середине экрана под курсором — убедиться, что она видна поверх игры
    ctx.handle("price:showTest", ["main"], async () => {
        if (!st().enabled) {
            st().enabled = true;
            ctx.saveSettings();
            apply();
        }
        await new Promise((res) => {
            const go = () => (ready ? res() : setTimeout(go, 200));
            go();
        });
        const d = screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).workArea;
        const c = { x: Math.round(d.x + d.width / 2), y: Math.round(d.y + d.height / 2) };
        scan = { x: c.x, y: c.y, t: Date.now(), tries: MAX_TRIES, busy: true, manual: true, preview: true };
        win.webContents.send("price:preview");
    });
    ctx.handle("price:openDebug", ["main"], async () => {
        await fsp.mkdir(debugDir, { recursive: true });
        shell.openPath(debugDir);
    });

    app.on("will-quit", () => {
        win?.destroy();
        stopForeground();
    });
    apply();

    return {
        /** Горячая клавиша: оценить предмет под курсором сейчас. */
        scanNow() {
            if (!st().enabled) {
                st().enabled = true;
                ctx.saveSettings();
                apply();
            }
            const p = screen.getCursorScreenPoint();
            const go = () => (ready ? request(p, true) : setTimeout(go, 300));
            go();
        },
        toggle() {
            st().enabled = !st().enabled;
            ctx.saveSettings();
            apply();
            return st().enabled;
        },
        isEnabled: () => st().enabled,
        /** Для автотестов: распознать в указанной точке экрана. */
        scanAt: (x, y) => request({ x, y }, true),
        scanAuto: (x, y) => request({ x, y }, false),
        /** Для автотестов: кадр — картинка (data URL), точка — в её пикселях. */
        scanImage: (image, w, h, x, y, manual = false) => {
            if (app.isPackaged || !win || !ready) return false;
            scan = { x: -1e6, y: -1e6, t: Date.now(), tries: 1, busy: true, manual, test: true };
            win.webContents.send("price:scan", { x, y, manual, debug: !!st().debug, display: { id: -1, bounds: { x: 0, y: 0, width: w, height: h }, scaleFactor: 1 }, testImage: image });
            return true;
        },
        window: () => win,
    };
}
