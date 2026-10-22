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
import { bestInLine, normalize, ocrOptions, similarity } from "../lib/ocr";
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
            return createWorker(["rus", "eng"], 1, ocrOptions());
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
 * Строки светлого текста на ровном тёмном фоне.
 * Сначала буквы — связные области светлых пикселей размером с символ (картинки предметов дают крупные
 * неровные области и в буквы не попадают), потом буквы одной высоты, стоящие рядом, — в строки.
 * Вокруг строки фон должен быть тёмным и однотонным.
 */
function findTextLines(img: ImageData, s: number): Box[] {
    const { width: W, height: H, data: d } = img;
    const N = W * H;
    const lum = new Float32Array(N);
    const ink = new Uint8Array(N);
    for (let i = 0, p = 0; p < N; p++, i += 4) {
        const r = d[i], g = d[i + 1], b = d[i + 2];
        lum[p] = 0.3 * r + 0.59 * g + 0.11 * b;
        ink[p] = lum[p] > 105 && Math.max(r, g, b) - Math.min(r, g, b) < 70 ? 1 : 0;
    }
    // связные области (8 соседей), только их рамки
    const label = new Int32Array(N);
    const comps: { x0: number; y0: number; x1: number; y1: number; n: number }[] = [];
    const stack: number[] = [];
    for (let p0 = 0; p0 < N; p0++) {
        if (!ink[p0] || label[p0]) continue;
        const c = { x0: W, y0: H, x1: 0, y1: 0, n: 0 };
        comps.push(c);
        const id = comps.length;
        label[p0] = id;
        stack.push(p0);
        while (stack.length) {
            const p = stack.pop()!;
            const x = p % W, y = (p - x) / W;
            c.n++;
            if (x < c.x0) c.x0 = x;
            if (x > c.x1) c.x1 = x;
            if (y < c.y0) c.y0 = y;
            if (y > c.y1) c.y1 = y;
            for (let dy = -1; dy <= 1; dy++)
                for (let dx = -1; dx <= 1; dx++) {
                    const xx = x + dx, yy = y + dy;
                    if (xx < 0 || yy < 0 || xx >= W || yy >= H) continue;
                    const q = yy * W + xx;
                    if (ink[q] && !label[q]) {
                        label[q] = id;
                        stack.push(q);
                    }
                }
        }
    }
    // буквы: высота и ширина как у символа
    const glyphs = comps.filter((c) => {
        const w = c.x1 - c.x0 + 1, h = c.y1 - c.y0 + 1;
        return h >= 3 * s && h <= 20 * s && w <= 48 * s; // соседние буквы при сглаживании сливаются
    });
    glyphs.sort((p, q) => p.x0 - q.x0);
    // строки: следующая буква рядом по горизонтали и на той же высоте
    type Line = { x0: number; y0: number; x1: number; y1: number; n: number; big: number };
    const lines: Line[] = [];
    const gap = Math.max(8, 12 * s);
    for (const g of glyphs) {
        const gh = g.y1 - g.y0 + 1;
        const gc = (g.y0 + g.y1) / 2;
        let best: Line | null = null;
        for (const l of lines) {
            if (g.x0 - l.x1 > gap || g.x0 < l.x0) continue;
            const lc = (l.y0 + l.y1) / 2;
            const lh = l.y1 - l.y0 + 1;
            if (Math.abs(gc - lc) > Math.max(3 * s, 0.45 * Math.max(lh, gh))) continue;
            if (!best || l.x1 > best.x1) best = l;
        }
        if (best) {
            best.x1 = Math.max(best.x1, g.x1);
            best.y0 = Math.min(best.y0, g.y0);
            best.y1 = Math.max(best.y1, g.y1);
            best.n++;
            if (gh >= 6 * s) best.big++;
        } else lines.push({ x0: g.x0, y0: g.y0, x1: g.x1, y1: g.y1, n: 1, big: gh >= 6 * s ? 1 : 0 });
    }
    const out: Box[] = [];
    for (const l of lines) {
        const lw = l.x1 - l.x0 + 1, lh = l.y1 - l.y0 + 1;
        if (l.n < 2 || l.big < 2 || lw < 14 * s || lh < 6 * s || lh > 26 * s) continue;
        const pad = Math.round(4 * s);
        const box = { x: Math.max(0, l.x0 - pad), y: Math.max(0, l.y0 - pad), w: 0, h: 0 };
        box.w = Math.min(W, l.x1 + 1 + pad) - box.x;
        box.h = Math.min(H, l.y1 + 1 + pad) - box.y;
        // фон вокруг текста: тёмный и ровный
        let n = 0, sum = 0, sum2 = 0;
        for (let y = box.y; y < box.y + box.h; y++)
            for (let x = box.x; x < box.x + box.w; x++) {
                const p = y * W + x;
                if (ink[p] || lum[p] > 90) continue; // сам текст и его сглаживание
                n++;
                sum += lum[p];
                sum2 += lum[p] * lum[p];
            }
        if (n < 20) continue;
        const mean = sum / n;
        const sd = Math.sqrt(Math.max(0, sum2 / n - mean * mean));
        if (mean > 70 || sd > 26) continue;
        out.push(box);
    }
    // куски одной строки (разрыв на тонких буквах или широком пробеле) — вместе
    out.sort((p, q) => p.x - q.x);
    const merged: Box[] = [];
    for (const b of out) {
        const m = merged.find((x) => Math.abs(x.y + x.h / 2 - (b.y + b.h / 2)) <= 5 * s && b.x - (x.x + x.w) <= 14 * s && b.x >= x.x);
        if (m) {
            const x2 = Math.max(m.x + m.w, b.x + b.w);
            const y0 = Math.min(m.y, b.y), y1 = Math.max(m.y + m.h, b.y + b.h);
            m.w = x2 - m.x;
            m.y = y0;
            m.h = y1 - y0;
        } else merged.push({ ...b });
    }
    return merged;
}

/** Строки одна под другой с одним левым краем — одна плашка: длинное название в подсказке переносится. */
function groupBlocks(lines: Box[], s: number): (Box & { lines: number })[] {
    const sorted = [...lines].sort((p, q) => p.y - q.y);
    const used = new Set<Box>();
    const blocks: (Box & { lines: number })[] = [];
    for (const l of sorted) {
        if (used.has(l)) continue;
        used.add(l);
        const blk = { ...l, lines: 1 };
        let last = l;
        for (const n of sorted) {
            if (used.has(n) || n.y <= last.y) continue;
            if (n.y - (last.y + last.h) > 7 * s || Math.abs(n.x - blk.x) > 7 * s) continue;
            used.add(n);
            const x2 = Math.max(blk.x + blk.w, n.x + n.w);
            const y2 = n.y + n.h;
            blk.x = Math.min(blk.x, n.x);
            blk.w = x2 - blk.x;
            blk.h = y2 - blk.y;
            blk.lines++;
            last = n;
        }
        blocks.push(blk);
    }
    return blocks;
}

const distTo = (b: Box, cx: number, cy: number) => Math.hypot(Math.max(b.x - cx, 0, cx - b.x - b.w), Math.max(b.y - cy, 0, cy - b.y - b.h));

/**
 * Подсказка игры: кусок текста у курсора — зацепка; вокруг него собираются все куски той же строки
 * и соседних строк (буквы поверх картинок предметов находятся не все, длинное название переносится).
 * Подпись клетки — короткое имя в правом верхнем углу предмета под курсором: выше курсора и правее него.
 */
function findTooltipAndLabel(img: ImageData, cx: number, cy: number, s: number) {
    const lines = findTextLines(img, s);
    const blocks = groupBlocks(lines, s);
    const near = lines.filter((l) => distTo(l, cx, cy) <= 40 * s).sort((p, q) => distTo(p, cx, cy) - distTo(q, cx, cy));
    let tooltip: (Box & { lines: number }) | null = null;
    const cluster = new Set<Box>();
    if (near.length) {
        const seed = near[0];
        const xL = seed.x - 380 * s, xR = seed.x + seed.w + 480 * s;
        cluster.add(seed);
        for (let grown = true; grown; ) {
            grown = false;
            for (const l of lines) {
                if (cluster.has(l) || l.x + l.w < xL || l.x > xR) continue;
                const touches = [...cluster].some((c) => l.y < c.y + c.h + 6 * s && l.y + l.h > c.y - 6 * s);
                if (!touches) continue;
                cluster.add(l);
                grown = true;
            }
        }
        const list = [...cluster];
        const x0 = Math.min(...list.map((l) => l.x)), y0 = Math.min(...list.map((l) => l.y));
        const x1 = Math.max(...list.map((l) => l.x + l.w)), y1 = Math.max(...list.map((l) => l.y + l.h));
        // строки: куски с близкими серединами
        const mids = list.map((l) => l.y + l.h / 2).sort((p, q) => p - q);
        let rows = 1;
        for (let i = 1; i < mids.length; i++) if (mids[i] - mids[i - 1] > 8 * s) rows++;
        const W = img.width, H = img.height;
        const pad = Math.round(10 * s);
        tooltip = { x: Math.max(0, x0 - pad), y: Math.max(0, y0 - 2), w: Math.min(W, x1 + pad) - Math.max(0, x0 - pad), h: Math.min(H, y1 + 2) - Math.max(0, y0 - 2), lines: rows };
        if (tooltip.w < 40 * s || rows > 4) tooltip = null;
    }
    const labels = lines.filter(
        (b) => !cluster.has(b) && b.w <= 160 * s && b.y + b.h <= cy + 8 * s && b.x + b.w >= cx - 8 * s && cy - b.y <= 260 * s && b.x + b.w - cx <= 260 * s,
    );
    labels.sort((p, q) => cy - p.y + 0.5 * (p.x + p.w - cx) - (cy - q.y + 0.5 * (q.x + q.w - cx)));
    return { tooltip, label: labels[0] ?? null, blocks };
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
        if (it.name.startsWith("!!!")) continue; // служебные записи tarkov.dev
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

type Hit = { item: MarketItem; score: number };

/** Полные названия, похожие на текст подсказки (строки склеены), — по убыванию похожести. */
function matchFull(text: string): Hit[] {
    const t = skel(text.replace(/\n+/g, " "));
    if (t.length < 4) return [];
    const best = new Map<MarketItem, number>();
    for (const e of index) {
        if (!e.full || e.key.length > t.length + Math.max(4, e.key.length * 0.35)) continue;
        let score = 0;
        if (Math.abs(e.key.length - t.length) <= Math.max(4, e.key.length * 0.35)) score = similarity(e.key, t);
        // внутри более длинного текста (к подсказке прилипли соседние подписи) — только длинные названия, с небольшим штрафом
        if (e.key.length >= 8 && t.length > e.key.length) score = Math.max(score, bestInLine(e.key, t) - 0.05);
        if (score > (best.get(e.item) ?? 0)) best.set(e.item, score);
    }
    return [...best].map(([item, score]) => ({ item, score })).sort((a, b) => b.score - a.score);
}

/** Предметы с этим коротким именем (подпись в углу клетки). */
function matchShort(text: string): Set<MarketItem> {
    const t = skel(text.replace(/\n+/g, " "));
    const out = new Set<MarketItem>();
    if (t.length < 2) return out;
    for (const e of index) if (!e.full && (e.key === t || (t.length >= 5 && similarity(e.key, t) >= 0.85))) out.add(e.item);
    return out;
}

/**
 * Итог: полное имя из подсказки, если оно уверенное; иначе — лучший из предметов, чьё короткое имя
 * совпало с подписью клетки. Лучше ничего не показать, чем показать чужую цену.
 */
function decide(full: Hit[], short: Set<MarketItem>): Hit | null {
    const top = full[0];
    if (top && top.score >= 0.86) return top;
    if (short.size) {
        const inShort = full.find((h) => short.has(h.item) && h.score >= 0.55);
        if (inShort) return inShort;
        if (short.size === 1 && !top) return { item: [...short][0], score: 0.8 };
    }
    if (top && top.score >= 0.8 && (full[1]?.score ?? 0) < top.score - 0.04) return top;
    return null;
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
        // кадр: экран или (в автотестах) картинка
        let v: { videoWidth: number; videoHeight: number; src: CanvasImageSource };
        if (req.testImage) {
            const im = new Image();
            im.src = req.testImage;
            await im.decode();
            v = { videoWidth: im.naturalWidth, videoHeight: im.naturalHeight, src: im };
        } else {
            await ensureStream(req.display.id);
            v = { videoWidth: video!.videoWidth, videoHeight: video!.videoHeight, src: video! };
        }
        // DIP → пиксели кадра
        const kx = v.videoWidth / req.display.bounds.width;
        const ky = v.videoHeight / req.display.bounds.height;
        // интерфейс игры вписывается в 1920×1080: на 16:10 и 4:3 масштаб задаёт ширина, на широких — высота
        // (в тесте картинка — кусок «экрана» 1080p, масштаб 1)
        const s = req.testImage ? 1 : Math.min(v.videoWidth / 1920, v.videoHeight / 1080);
        const px = (req.x - req.display.bounds.x) * kx;
        const py = (req.y - req.display.bounds.y) * ky;
        // подсказка бывает левее и выше курсора, длинное название — в несколько строк
        const area = {
            x: Math.max(0, Math.round(px - 240 * s)),
            y: Math.max(0, Math.round(py - 150 * s)),
            w: 0,
            h: 0,
        };
        area.w = Math.min(v.videoWidth - area.x, Math.round(900 * s));
        area.h = Math.min(v.videoHeight - area.y, Math.round(300 * s));
        const c = document.createElement("canvas");
        c.width = area.w;
        c.height = area.h;
        const g = c.getContext("2d", { willReadFrequently: true })!;
        g.drawImage(v.src, area.x, area.y, area.w, area.h, 0, 0, area.w, area.h);
        const img = g.getImageData(0, 0, area.w, area.h);
        const { tooltip, label, blocks } = findTooltipAndLabel(img, px - area.x, py - area.y, s);
        let debugPng = "";
        const box = tooltip;
        let text = "";
        let labelText = "";
        let used: Box | null = null;
        const w = await getWorker();
        const scale = Math.max(1.5, 2.2 / s);
        let full: Hit[] = [];
        if (tooltip) {
            await w.setParameters({ tessedit_pageseg_mode: (tooltip.lines > 1 ? "6" : "7") as never });
            text = (await w.recognize(toOcrCanvas(c, tooltip, scale))).data.text;
            full = matchFull(text);
            used = tooltip;
        }
        // подпись клетки: проверка, если подсказка прочиталась неуверенно (или её нет, а нажата горячая клавиша)
        let short = new Set<MarketItem>();
        if (label && (full[0]?.score ?? 0) < 0.86 && (tooltip || req.manual)) {
            await w.setParameters({ tessedit_pageseg_mode: "7" as never });
            labelText = (await w.recognize(toOcrCanvas(c, label, scale))).data.text;
            short = matchShort(labelText);
        }
        const m = decide(full, short);
        if (m && !used && label) used = label;
        text = `подсказка: ${text.trim()} | подпись: ${labelText.trim()}`;
        if (req.debug) {
            // разметка на кадре: строки — зелёным, подсказка — жёлтым, подпись клетки — голубым, курсор — красным
            const dc = document.createElement("canvas");
            dc.width = c.width;
            dc.height = c.height;
            const dg = dc.getContext("2d")!;
            dg.drawImage(c, 0, 0);
            dg.lineWidth = 1;
            for (const [col, list] of [["#3c3", blocks], ["#fd0", tooltip ? [tooltip] : []], ["#3cf", label ? [label] : []]] as [string, Box[]][]) {
                dg.strokeStyle = col;
                for (const b of list) dg.strokeRect(b.x + 0.5, b.y + 0.5, b.w - 1, b.h - 1);
            }
            dg.fillStyle = "#f33";
            dg.fillRect(px - area.x - 2, py - area.y - 2, 5, 5);
            debugPng = dc.toDataURL("image/png");
        }
        if (req.debug) desktop!.price.debug({ png: debugPng, text, box: { tooltip, label, blocks: blocks.map((b) => [b.x, b.y, b.w, b.h, b.lines]) }, item: m?.item.name ?? null, score: m?.score ?? null });
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
