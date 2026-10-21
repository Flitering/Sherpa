// Подробная многоэтажная сетка вокруг цели: комнаты, дверные проёмы, лестницы.
//
// В SVG-картах интерьер нарисован слоями этажей: комнаты — многоугольники класса floor,
// стены — зазоры между ними, проём — место, где пол переходит из комнаты в комнату или на улицу,
// лестницы — класс stairs (один и тот же символ лестницы стоит на соседних этажах).
// Растеризуем окно ~140×140 м вокруг цели с клеткой 0.25 м — так стены не теряются.

import L from "leaflet";
import type { GameMap, LayerExtent, Vec3 } from "../types";
import { makeCRS, onLevel, toBounds } from "./crs";
import { classifyOutdoor, COST, RASTER_CSS } from "./navgrid";

const F = "#00ff00"; // пол
const S = "#ffff00"; // лестница
const K = "#ff8000"; // закрыто

const FLOOR_CSS = `
* { shape-rendering: crispEdges !important; filter: none !important; }
svg * { fill: transparent !important; stroke: none !important; }
text { display: none !important; }
.floor, .floor * { fill: ${F} !important; }
.locked, .locked * { fill: ${K} !important; }
.stairs, .stairs *, .stairs use { fill: ${S} !important; }
`;

export interface DetailLayer {
    name: string;
    /** null — основной уровень карты */
    svgLayer: string | null;
    extents?: LayerExtent[];
    cost: Uint8Array;
    stairs: Uint8Array;
    /** только для основного уровня: 1 — клетка внутри здания (пол интерьера) */
    indoor?: Uint8Array;
}

export interface DetailGrid {
    w: number;
    h: number;
    cellMeters: number;
    layers: DetailLayer[];
    toCell: (p: { x: number; z: number }) => number;
    toGame: (cell: number) => { x: number; z: number };
    layerOf: (p: Vec3) => number;
    center: { x: number; z: number };
    radius: number;
}

async function render(svgText: string, keep: (g: Element) => boolean, css: string, viewBox: number[], w: number, h: number) {
    const doc = new DOMParser().parseFromString(svgText, "image/svg+xml");
    const svg = doc.documentElement;
    svg.setAttribute("width", String(w));
    svg.setAttribute("height", String(h));
    svg.setAttribute("viewBox", viewBox.join(" "));
    svg.setAttribute("preserveAspectRatio", "none");
    for (const g of Array.from(svg.children)) {
        if (g.nodeName !== "g" || !g.id) continue;
        if (!keep(g)) g.remove();
    }
    const style = doc.createElementNS("http://www.w3.org/2000/svg", "style");
    style.textContent = css;
    svg.appendChild(style);
    const url = URL.createObjectURL(new Blob([new XMLSerializer().serializeToString(svg)], { type: "image/svg+xml" }));
    try {
        const img = new Image();
        img.src = url;
        await img.decode();
        const c = document.createElement("canvas");
        c.width = w;
        c.height = h;
        const ctx = c.getContext("2d", { willReadFrequently: true })!;
        ctx.drawImage(img, 0, 0, w, h);
        return ctx.getImageData(0, 0, w, h).data;
    } finally {
        URL.revokeObjectURL(url);
    }
}

/** Пиксели этажа → пол / лестница / закрыто. */
function classifyFloor(px: Uint8ClampedArray, n: number) {
    const cost = new Uint8Array(n);
    const stairs = new Uint8Array(n);
    let any = 0;
    for (let i = 0; i < n; i++) {
        if (px[i * 4 + 3] < 128) continue;
        const r = px[i * 4], g = px[i * 4 + 1], b = px[i * 4 + 2];
        if (r > 200 && g > 200 && b < 80) {
            cost[i] = COST.open;
            stairs[i] = 1;
        } else if (r > 200 && g > 90 && g < 170 && b < 80) cost[i] = COST.locked;
        else if (g > 200 && r < 80) cost[i] = COST.open;
        else continue;
        any++;
    }
    return { cost, stairs, any };
}

export async function buildDetailGrid(map: GameMap, svgText: string, center: { x: number; z: number }, radius = 70, cellMeters = 0.25): Promise<DetailGrid> {
    const d = map.display;
    const crs = makeCRS(d);
    const b = toBounds(d.svgBounds ?? d.bounds);
    const p1 = crs.latLngToPoint(b.getNorthWest(), 0);
    const p2 = crs.latLngToPoint(b.getSouthEast(), 0);
    const rect = L.bounds(p1, p2);
    const rw = rect.max!.x - rect.min!.x;
    const rh = rect.max!.y - rect.min!.y;

    const vbMatch = /viewBox="([^"]+)"/.exec(svgText.slice(0, 2000));
    const vb = (vbMatch?.[1] ?? "0 0 1 1").split(/[\s,]+/).map(Number);
    const toSvg = (p: { x: number; z: number }) => {
        const pt = crs.latLngToPoint(L.latLng(p.z, p.x), 0);
        return { u: vb[0] + ((pt.x - rect.min!.x) / rw) * vb[2], v: vb[1] + ((pt.y - rect.min!.y) / rh) * vb[3] };
    };
    const corners = [
        toSvg({ x: center.x - radius, z: center.z - radius }),
        toSvg({ x: center.x + radius, z: center.z + radius }),
        toSvg({ x: center.x - radius, z: center.z + radius }),
        toSvg({ x: center.x + radius, z: center.z - radius }),
    ];
    const u0 = Math.min(...corners.map((c) => c.u));
    const u1 = Math.max(...corners.map((c) => c.u));
    const v0 = Math.min(...corners.map((c) => c.v));
    const v1 = Math.max(...corners.map((c) => c.v));
    const w = Math.round((2 * radius) / cellMeters);
    const h = Math.round(((v1 - v0) / (u1 - u0)) * w);
    const n = w * h;
    const viewBox = [u0, v0, u1 - u0, v1 - v0];

    const toCell = (p: { x: number; z: number }) => {
        const s = toSvg(p);
        const cx = Math.min(w - 1, Math.max(0, Math.floor(((s.u - u0) / (u1 - u0)) * w)));
        const cy = Math.min(h - 1, Math.max(0, Math.floor(((s.v - v0) / (v1 - v0)) * h)));
        return cy * w + cx;
    };
    const toGame = (cell: number) => {
        const u = u0 + (((cell % w) + 0.5) / w) * (u1 - u0);
        const v = v0 + ((Math.floor(cell / w) + 0.5) / h) * (v1 - v0);
        const ll = crs.pointToLatLng(L.point(rect.min!.x + ((u - vb[0]) / vb[2]) * rw, rect.min!.y + ((v - vb[1]) / vb[3]) * rh), 0);
        return { x: ll.lng, z: ll.lat };
    };

    // --- основной уровень: улица из общей сетки + интерьер первого этажа ---
    const keepWith = (g: Element) => g.getAttribute("data-keep-with-group") === d.svgLayer;
    const interiorPx = await render(svgText, keepWith, FLOOR_CSS, viewBox, w, h);
    const interior = classifyFloor(interiorPx, n);
    const outdoor = classifyOutdoor(await render(svgText, (g) => g.id === d.svgLayer, RASTER_CSS, viewBox, w, h), n);
    const ground: DetailLayer = { name: "Основной", svgLayer: null, extents: d.heightRange ? [{ height: d.heightRange }] : undefined, cost: new Uint8Array(n), stairs: interior.stairs, indoor: new Uint8Array(n) };
    for (let i = 0; i < n; i++) {
        if (interior.cost[i]) {
            ground.cost[i] = interior.cost[i];
            ground.indoor![i] = 1;
            continue;
        }
        const out = outdoor[i];
        // Здание без нарисованного интерьера в этом месте — стена (если интерьеры у карты вообще есть).
        ground.cost[i] = out === COST.building && interior.any > 0 ? 0 : out;
    }

    // --- остальные этажи ---
    const layers: DetailLayer[] = [ground];
    for (const l of d.layers) {
        if (!l.svgLayer) continue;
        const px = await render(svgText, (g) => g.id === l.svgLayer, FLOOR_CSS, viewBox, w, h);
        const f = classifyFloor(px, n);
        if (!f.any) continue;
        layers.push({ name: l.name, svgLayer: l.svgLayer, extents: l.extents, cost: f.cost, stairs: f.stairs });
    }
    // порядок снизу вверх по высоте
    const mid = (l: DetailLayer) => {
        const e = l.extents?.[0]?.height;
        if (!e) return 0;
        const lo = Math.max(e[0], -50);
        const hi = Math.min(e[1], 80);
        return (lo + hi) / 2;
    };
    layers.sort((a, b) => mid(a) - mid(b));

    const layerOf = (p: Vec3) => {
        // сначала дополнительные этажи (у них узкие диапазоны), потом основной
        for (let i = 0; i < layers.length; i++) {
            const l = layers[i];
            if (l.svgLayer && l.extents && onLevel(p, l.extents)) return i;
        }
        return layers.indexOf(ground);
    };

    return { w, h, cellMeters, layers, toCell, toGame, layerOf, center, radius };
}

// ---------------- подробный маршрут ----------------

export type DetailEventKind = "door-in" | "door-out" | "up" | "down";

export interface DetailRoute {
    /** Участок до окна подробной сетки (по общей сетке, на основном уровне). */
    approach: [number, number][];
    segments: { layer: number; layerName: string; svgLayer: string | null; points: [number, number][] }[];
    events: { kind: DetailEventKind; x: number; z: number; layerName: string; toLayerName?: string }[];
    length: number;
    targetLayer: { name: string; svgLayer: string | null };
}

let worker: Worker | null = null;
let seq = 0;
const pending = new Map<number, (r: unknown) => void>();
function call<T>(msg: object, transfer: Transferable[]): Promise<T> {
    if (!worker) {
        worker = new Worker(new URL("./detailWorker.ts", import.meta.url), { type: "module" });
        worker.onmessage = (e) => {
            const cb = pending.get(e.data.id);
            pending.delete(e.data.id);
            if (e.data.error || e.data.reason) console.warn("detailWorker:", e.data.error ?? e.data.reason);
            cb?.(e.data.error ? null : e.data.result);
        };
    }
    const id = ++seq;
    return new Promise<T>((resolve) => {
        pending.set(id, resolve as (r: unknown) => void);
        worker!.postMessage({ ...msg, id }, transfer);
    });
}

const gridCache = new Map<string, Promise<DetailGrid>>();
const RADIUS = 70;

function gridFor(map: GameMap, svgText: string, target: Vec3) {
    // окно привязываем к сетке 20 м, чтобы соседние цели использовали одну и ту же сетку
    const cx = Math.round(target.x / 20) * 20;
    const cz = Math.round(target.z / 20) * 20;
    const key = `${map.key}:${cx}:${cz}`;
    let g = gridCache.get(key);
    if (!g) {
        g = buildDetailGrid(map, svgText, { x: cx, z: cz }, RADIUS);
        gridCache.set(key, g);
        if (gridCache.size > 12) gridCache.delete(gridCache.keys().next().value!);
    }
    return g;
}

/** Первая точка пути, попадающая в окно (с запасом), — с интерполяцией по отрезкам. */
function entryPoint(path: [number, number][], center: { x: number; z: number }, r: number): { idx: number; p: [number, number] } | null {
    const inside = (x: number, z: number) => Math.abs(x - center.x) < r && Math.abs(z - center.z) < r;
    for (let i = 1; i < path.length; i++) {
        const [x0, z0] = path[i - 1];
        const [x1, z1] = path[i];
        const steps = Math.max(1, Math.ceil(Math.hypot(x1 - x0, z1 - z0) / 2));
        for (let s = 0; s <= steps; s++) {
            const x = x0 + ((x1 - x0) * s) / steps;
            const z = z0 + ((z1 - z0) * s) / steps;
            if (inside(x, z)) return { idx: i - 1, p: [x, z] };
        }
    }
    return null;
}

const LAYER_RU: Record<string, string> = {
    "Основной": "1 этаж",
    "2nd Floor": "2 этаж",
    "3rd Floor": "3 этаж",
    "4th Floor": "4 этаж",
    "5th Floor": "5 этаж",
    Underground: "подвал",
    Tunnels: "тоннели",
    Bunkers: "бункеры",
    Garage: "гараж",
    "Second Level": "2 уровень",
    Technical: "техэтаж",
};
export const layerRu = (n: string) => LAYER_RU[n] ?? n;

/**
 * Маршрут from → to с подробностями у цели.
 * overviewPath — путь по общей сетке (from → to), из него берём подход к окну.
 */
export async function detailRoute(
    map: GameMap,
    svgText: string,
    from: Vec3,
    to: Vec3,
    overviewPath: [number, number][] | null,
): Promise<DetailRoute | null> {
    const grid = await gridFor(map, svgText, to);
    const margin = grid.radius - 4;
    let approach: [number, number][] = [];
    let start = from;
    let startLayer = grid.layerOf(from);
    const fromInside = Math.abs(from.x - grid.center.x) < margin && Math.abs(from.z - grid.center.z) < margin;
    if (!fromInside) {
        const path = overviewPath ?? [
            [from.x, from.z],
            [to.x, to.z],
        ];
        const e = entryPoint(path, grid.center, margin);
        if (!e) return null;
        approach = [...path.slice(0, e.idx + 1), e.p];
        start = { x: e.p[0], y: 0, z: e.p[1] };
        startLayer = grid.layers.findIndex((l) => l.svgLayer === null);
    }
    const toLayer = grid.layerOf(to);
    const layers = grid.layers.map((l) => ({ cost: l.cost.slice(), stairs: l.stairs.slice(), indoor: l.indoor?.slice() }));
    const transfer: Transferable[] = layers.flatMap((l) => [l.cost.buffer, l.stairs.buffer, ...(l.indoor ? [l.indoor.buffer] : [])]);
    const r = await call<{
        segments: { layer: number; cells: Int32Array }[];
        events: { kind: DetailEventKind; cell: number; layer: number; toLayer?: number }[];
        length: number;
    } | null>({ w: grid.w, h: grid.h, cellMeters: grid.cellMeters, layers, from: { l: startLayer, c: grid.toCell(start) }, to: { l: toLayer, c: grid.toCell(to) } }, transfer);
    if (!r) return null;
    const pt = (c: number): [number, number] => {
        const g = grid.toGame(c);
        return [g.x, g.z];
    };
    const segments = r.segments.map((s) => ({
        layer: s.layer,
        layerName: grid.layers[s.layer].name,
        svgLayer: grid.layers[s.layer].svgLayer,
        points: Array.from(s.cells, pt),
    }));
    // концы — точно в точки
    if (segments.length) {
        const last = segments[segments.length - 1].points;
        last[last.length - 1] = [to.x, to.z];
        if (!approach.length) segments[0].points[0] = [from.x, from.z];
    }
    let approachLen = 0;
    for (let i = 1; i < approach.length; i++) approachLen += Math.hypot(approach[i][0] - approach[i - 1][0], approach[i][1] - approach[i - 1][1]);
    return {
        approach,
        segments,
        events: r.events.map((e) => {
            const [x, z] = pt(e.cell);
            return { kind: e.kind, x, z, layerName: grid.layers[e.layer].name, toLayerName: e.toLayer !== undefined ? grid.layers[e.toLayer].name : undefined };
        }),
        length: approachLen + r.length,
        targetLayer: { name: grid.layers[toLayer].name, svgLayer: grid.layers[toLayer].svgLayer },
    };
}

/** Короткое текстовое описание: «вход → лестница на 3 этаж → цель». */
export function describeRoute(r: DetailRoute): string[] {
    const out: string[] = [];
    const ev = r.events;
    for (let i = 0; i < ev.length; i++) {
        const e = ev[i];
        // вход и сразу выход (без лестниц) — просто проход сквозь здание
        if (e.kind === "door-in" && ev[i + 1]?.kind === "door-out") {
            if (out[out.length - 1] !== "сквозь здание") out.push("сквозь здание");
            i++;
            continue;
        }
        if (e.kind === "door-out" && ev[i + 1]?.kind === "door-in" && i + 2 < ev.length) {
            // выход и вход в соседнее здание — через двор
            out.push("через двор");
            i++;
            continue;
        }
        if (e.kind === "door-in") out.push("вход в здание");
        else if (e.kind === "door-out") out.push("выход на улицу");
        else out.push(`${e.kind === "up" ? "▲ подняться" : "▼ спуститься"} на ${layerRu(e.toLayerName ?? "")}`);
    }
    // склеиваем подряд идущие подъёмы: «▲ на 2 этаж, ▲ на 3 этаж» → «▲ подняться на 3 этаж»
    const merged: string[] = [];
    for (const s of out) {
        const prev = merged[merged.length - 1];
        if (prev && prev.slice(0, 2) === s.slice(0, 2) && (s.startsWith("▲") || s.startsWith("▼"))) merged[merged.length - 1] = s;
        else merged.push(s);
    }
    merged.push(`цель (${layerRu(r.targetLayer.name)})`);
    return merged;
}
