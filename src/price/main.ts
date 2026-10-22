// Окно «цена по наведению». Невидимо, пока нечего показать: держит захват экрана и распознаватель.
//
// Основной процесс замечает, что курсор замер, и присылает точку. Здесь из кадра вырезается область
// вокруг курсора, в ней ищется всплывающая подсказка игры с названием предмета (тёмная плашка
// со светлым текстом), название распознаётся и сопоставляется с базой tarkov.dev. Окно рисует
// цену и сообщает свой размер — основной процесс ставит его под подсказку.

import "@fontsource/roboto-condensed/400.css";
import "@fontsource/roboto-condensed/700.css";
import "./price.css";
import { dataUrl, desktop, type PriceScan } from "../lib/desktop";
import { advise, loadMarket, rub, type Market, type MarketItem } from "../lib/market";
import { normalize, similarity } from "../lib/ocr";
import type { Bundle, GameMode } from "../types";

type TWorker = Awaited<ReturnType<typeof import("tesseract.js")["createWorker"]>>;

const root = document.getElementById("root")!;

// ---------------- захват экрана ----------------

let video: HTMLVideoElement | null = null;
let stream: MediaStream | null = null;
let streamDisplay: number | null = null;
let idleTimer = 0;

async function ensureStream(displayId: number) {
    if (stream && streamDisplay === displayId && stream.active) return;
    stopStream();
    // основной процесс сам выбирает нужный монитор — без окна выбора
    stream = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: { ideal: 10, max: 15 } }, audio: false });
    streamDisplay = displayId;
    video = document.createElement("video");
    video.muted = true;
    video.srcObject = stream;
    await video.play();
    // первый кадр
    if (!video.videoWidth) await new Promise((r) => video!.addEventListener("loadeddata", r, { once: true }));
}

function stopStream() {
    stream?.getTracks().forEach((t) => t.stop());
    stream = null;
    streamDisplay = null;
    video = null;
}

// ---------------- распознавание ----------------

let worker: Promise<TWorker> | null = null;
function getWorker() {
    if (!worker) {
        worker = (async () => {
            const { createWorker } = await import("tesseract.js");
            return createWorker(["rus", "eng"], 1);
        })();
        worker.catch(() => (worker = null));
    }
    return worker;
}

interface Box {
    x: number;
    y: number;
    w: number;
    h: number;
}

/**
 * Ищет строки светлого текста на ровном тёмном фоне — так выглядит подсказка игры с названием предмета.
 * Фон схрона тоже тёмный, поэтому ищется сам текст: полосы строк со светлыми пикселями, внутри них —
 * слова, разделённые небольшими промежутками; вокруг текста фон должен быть однотонным.
 * Возвращает до трёх кандидатов, ближайших к курсору.
 */
function findTextBoxes(img: ImageData, cx: number, cy: number, s: number): Box[] {
    const { width: W, height: H, data: d } = img;
    const lum = new Float32Array(W * H);
    const ink = new Uint8Array(W * H);
    for (let i = 0, p = 0; p < W * H; p++, i += 4) {
        const r = d[i], g = d[i + 1], b = d[i + 2];
        lum[p] = 0.3 * r + 0.59 * g + 0.11 * b;
        ink[p] = lum[p] > 135 && Math.max(r, g, b) - Math.min(r, g, b) < 70 ? 1 : 0;
    }
    // полосы строк со светлыми пикселями
    const rowInk = new Uint16Array(H);
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) rowInk[y] += ink[y * W + x];
    const bands: [number, number][] = [];
    for (let y = 0; y < H; ) {
        if (rowInk[y] < 2) {
            y++;
            continue;
        }
        let e = y;
        while (e + 1 < H && (rowInk[e + 1] >= 2 || (e + 2 < H && rowInk[e + 2] >= 2))) e++;
        bands.push([y, e + 1]);
        y = e + 1;
    }
    const out: Box[] = [];
    const gap = Math.max(6, 9 * s);
    for (const [y0, y1] of bands) {
        const h = y1 - y0;
        if (h < 6 * s || h > 26 * s) continue;
        // слова → фразы: столбцы с текстом, промежутки меньше gap склеиваются
        let a = -1;
        let lastInk = -1;
        const segs: [number, number][] = [];
        for (let x = 0; x < W; x++) {
            let col = 0;
            for (let y = y0; y < y1; y++) col += ink[y * W + x];
            if (col) {
                if (a < 0) a = x;
                lastInk = x;
            } else if (a >= 0 && x - lastInk > gap) {
                segs.push([a, lastInk + 1]);
                a = -1;
            }
        }
        if (a >= 0) segs.push([a, lastInk + 1]);
        for (const [x0, x1] of segs) {
            if (x1 - x0 < 24 * s) continue;
            const pad = Math.round(4 * s);
            const box = { x: Math.max(0, x0 - pad), y: Math.max(0, y0 - pad), w: 0, h: 0 };
            box.w = Math.min(W, x1 + pad) - box.x;
            box.h = Math.min(H, y1 + pad) - box.y;
            // фон вокруг текста: тёмный и ровный
            let n = 0, sum = 0, sum2 = 0;
            for (let y = box.y; y < box.y + box.h; y++)
                for (let x = box.x; x < box.x + box.w; x++) {
                    const p = y * W + x;
                    if (ink[p] || lum[p] > 110) continue; // сам текст и его сглаживание
                    n++;
                    sum += lum[p];
                    sum2 += lum[p] * lum[p];
                }
            if (n < 20) continue;
            const mean = sum / n;
            const sd = Math.sqrt(Math.max(0, sum2 / n - mean * mean));
            if (mean > 60 || sd > 22) continue;
            out.push(box);
        }
    }
    const dist = (b: Box) => Math.hypot(Math.max(b.x - cx, 0, cx - b.x - b.w), Math.max(b.y - cy, 0, cy - b.y - b.h));
    return out.sort((p, q) => dist(p) - dist(q)).slice(0, 3);
}

/** Светлый текст на тёмном → чёрный текст на белом, крупнее: так Tesseract читает надёжнее. */
function toOcrCanvas(src: CanvasImageSource, box: Box, scale: number): HTMLCanvasElement {
    const c = document.createElement("canvas");
    c.width = Math.round(box.w * scale);
    c.height = Math.round(box.h * scale);
    const g = c.getContext("2d", { willReadFrequently: true })!;
    g.imageSmoothingQuality = "high";
    g.drawImage(src, box.x, box.y, box.w, box.h, 0, 0, c.width, c.height);
    const img = g.getImageData(0, 0, c.width, c.height);
    const d = img.data;
    for (let i = 0; i < d.length; i += 4) {
        const v = 0.3 * d[i] + 0.59 * d[i + 1] + 0.11 * d[i + 2] > 120 ? 0 : 255;
        d[i] = d[i + 1] = d[i + 2] = v;
    }
    g.putImageData(img, 0, 0);
    return c;
}

// ---------------- база предметов ----------------

let mode: GameMode | null = null;
let market: Market | null = null;
let bundle: Bundle | null = null;
let index: { key: string; item: MarketItem; full: boolean }[] = [];

/** Латиница, похожая на кириллицу, и наоборот — к одному виду: OCR их путает. */
const SKELETON: Record<string, string> = { a: "а", e: "е", o: "о", p: "р", c: "с", x: "х", y: "у", k: "к", m: "м", t: "т", h: "н", b: "в" };
const skel = (s: string) => normalize(s).replace(/[a-z]/g, (ch) => SKELETON[ch] ?? ch);

async function ensureData() {
    const st = readState();
    const m: GameMode = st?.mode === "pve" ? "pve" : "regular";
    if (market && mode === m) return;
    mode = m;
    market = await loadMarket(m);
    bundle = await (await fetch(dataUrl(`data/${m}.json`))).json();
    index = [];
    for (const it of market.list) {
        for (const [name, full] of [
            [it.name, true],
            [it.en, true],
            [it.short, false],
            [it.enShort, false],
        ] as [string | undefined, boolean][]) {
            if (!name) continue;
            const key = skel(name);
            if (key.length >= (full ? 4 : 3)) index.push({ key, item: it, full });
        }
    }
}

/** Короткие имена (как в углу клетки) — только по горячей клавише: в схроне их рядом много. */
function match(text: string, allowShort = false): { item: MarketItem; score: number } | null {
    let best: { item: MarketItem; score: number } | null = null;
    const lines = text.split(/\n+/).map(skel).filter((l) => l.length >= 3);
    for (const line of lines) {
        for (const e of index) {
            if (!e.full && !allowShort) continue;
            if (Math.abs(e.key.length - line.length) > Math.max(3, e.key.length * 0.3)) continue;
            let score = similarity(e.key, line);
            if (!e.full) score -= 0.08; // короткие имена — только при почти точном совпадении
            if (!best || score > best.score) best = { item: e.item, score };
        }
    }
    return best && best.score >= 0.78 ? best : null;
}

// ---------------- прогресс игрока (из общего хранилища приложения) ----------------

interface SavedState {
    mode?: GameMode;
    players?: { name: string; color: string; tasks: Record<string, string>; objectivesDone: Record<string, true> }[];
    intelCenter?: boolean;
}
function readState(): SavedState | null {
    try {
        return JSON.parse(localStorage.getItem("sherpa:v1") ?? "null");
    } catch {
        return null;
    }
}

/** Активные квесты игроков, которым нужен этот предмет. */
function questNeeds(itemId: string): { quest: string; count: number; fir: boolean; player: string; color: string }[] {
    const st = readState();
    if (!bundle || !st?.players) return [];
    const out: { quest: string; count: number; fir: boolean; player: string; color: string }[] = [];
    for (const t of bundle.tasks) {
        for (const o of t.objectives) {
            if (o.type !== "giveItem" || !o.items?.includes(itemId)) continue;
            for (const p of st.players) {
                if (p.tasks[t.id] !== "active" || p.objectivesDone[o.id]) continue;
                out.push({ quest: t.name, count: o.count ?? 1, fir: !!o.fir, player: p.name, color: p.color });
            }
        }
    }
    return out.slice(0, 4);
}

// ---------------- отрисовка ----------------

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

function render(item: MarketItem) {
    const a = advise(market!, item, !!readState()?.intelCenter);
    const trader = item.trader ? bundle?.traders[item.trader]?.name ?? "" : "";
    const slots = item.w * item.h;
    const needs = questNeeds(item.id);
    const flea = item.noFlea ? `<span class="pc-dim">нельзя продать на барахолке</span>` : `${rub(item.lastLow ?? item.avg24)}`;
    root.innerHTML = `
      <div class="pc">
        <div class="pc-head">
          ${item.icon ? `<img src="${esc(item.icon)}" alt="">` : ""}
          <div><b>${esc(item.name)}</b><span class="pc-dim">${esc(item.short)} · ${item.w}×${item.h}</span></div>
        </div>
        <div class="pc-row ${a.best === "flea" ? "best" : ""}"><span>Барахолка</span><b>${flea}</b></div>
        ${a.fleaNet != null ? `<div class="pc-sub">выставить за ${rub(a.fleaPrice)} → чистыми ${rub(a.fleaNet)}</div>` : ""}
        <div class="pc-row ${a.best === "trader" ? "best" : ""}"><span>${trader ? esc(trader) : "Торговцу"}</span><b>${rub(item.traderPrice)}</b></div>
        <div class="pc-row slot"><span>За клетку${slots > 1 ? ` (${slots})` : ""}</span><b>${rub(a.perSlot)}</b></div>
        ${needs
            .map((n) => `<div class="pc-quest"><i style="background:${esc(n.color)}"></i>${esc(n.player)}: «${esc(n.quest)}» — ${n.count} шт.${n.fir ? " <span class='fir'>FIR</span>" : ""}</div>`)
            .join("")}
      </div>`;
}

function renderMiss() {
    root.innerHTML = `<div class="pc pc-miss">Предмет не распознан — наведи на него и подожди подсказку игры</div>`;
}

// ---------------- обработка запроса ----------------

desktop!.price.onScan(async (req: PriceScan) => {
    clearTimeout(idleTimer);
    idleTimer = window.setTimeout(stopStream, 90_000); // без сканов захват выключается
    try {
        await ensureData();
        await ensureStream(req.display.id);
        const v = video!;
        // DIP → пиксели кадра
        const kx = v.videoWidth / req.display.bounds.width;
        const ky = v.videoHeight / req.display.bounds.height;
        const s = v.videoHeight / 1080; // интерфейс игры масштабируется по высоте
        const px = (req.x - req.display.bounds.x) * kx;
        const py = (req.y - req.display.bounds.y) * ky;
        const area = {
            x: Math.max(0, Math.round(px - 60 * s)),
            y: Math.max(0, Math.round(py - 50 * s)),
            w: 0,
            h: 0,
        };
        area.w = Math.min(v.videoWidth - area.x, Math.round(700 * s));
        area.h = Math.min(v.videoHeight - area.y, Math.round(170 * s));
        const c = document.createElement("canvas");
        c.width = area.w;
        c.height = area.h;
        const g = c.getContext("2d", { willReadFrequently: true })!;
        g.drawImage(v, area.x, area.y, area.w, area.h, 0, 0, area.w, area.h);
        const img = g.getImageData(0, 0, area.w, area.h);
        const boxes = findTextBoxes(img, px - area.x, py - area.y, s);
        const box = boxes[0] ?? null;
        let text = "";
        let used: Box | null = null;
        let m: ReturnType<typeof match> = null;
        const w = await getWorker();
        // ближайшие к курсору строки текста по очереди, пока одна не окажется названием предмета
        await w.setParameters({ tessedit_pageseg_mode: "7" as never });
        for (const b of boxes) {
            const t = (await w.recognize(toOcrCanvas(c, b, Math.max(1.5, 2.2 / s)))).data.text;
            text += t;
            const hit = match(t, req.manual);
            if (hit && (!m || hit.score > m.score)) (m = hit), (used = b);
            if (m && m.score > 0.9) break;
        }
        if (!m && req.manual) {
            // по горячей клавише — читаем всю область целиком
            await w.setParameters({ tessedit_pageseg_mode: "11" as never });
            const t = (await w.recognize(toOcrCanvas(c, { x: 0, y: 0, w: area.w, h: area.h }, Math.max(1.2, 1.8 / s)))).data.text;
            text += "\n" + t;
            m = match(t, true);
            if (m) used = { x: 0, y: 0, w: area.w, h: area.h };
        }
        if (req.debug) desktop!.price.debug({ png: c.toDataURL("image/png"), text, box: boxes, item: m?.item.name ?? null, score: m?.score ?? null });
        if (!m && !req.manual) {
            desktop!.price.result({ found: false, tooltip: !!box, width: 0, height: 0 });
            return;
        }
        if (m) render(m.item);
        else renderMiss();
        await new Promise((r) => requestAnimationFrame(() => r(null)));
        const card = root.firstElementChild as HTMLElement;
        // где была подсказка — в координатах экрана (DIP), чтобы окно встало прямо под ней
        const tip = used
            ? { x: req.display.bounds.x + (area.x + used.x) / kx, y: req.display.bounds.y + (area.y + used.y) / ky, w: used.w / kx, h: used.h / ky }
            : null;
        desktop!.price.result({ found: !!m, tooltip: !!box, width: Math.ceil(card.offsetWidth), height: Math.ceil(card.offsetHeight), tip, name: m?.item.name });
    } catch (e) {
        desktop!.price.result({ found: false, tooltip: false, width: 0, height: 0, error: String((e as Error)?.message ?? e) });
    }
});

// распознаватель грузится заранее, чтобы первая подсказка не ждала словари
getWorker();
