// Сетка проходимости карты из SVG-подложки.
//
// SVG-карты tarkov-dev-svg-maps используют общие классы: building, fence, water, rock, danger,
// map_border… Мы перекрашиваем их в «служебные» цвета, рисуем основной этаж в холст без
// сглаживания (crispEdges) и по цвету пикселя получаем стоимость прохода клетки.
// Сам поиск пути выполняется в Web Worker (pathWorker.ts).

import L from "leaflet";
import type { GameMap, Vec3 } from "../types";
import { makeCRS, toBounds } from "./crs";
import { classifyHazards, type HazardClasses } from "./hazards";

/** Стоимость клетки ×10: 0 — непроходимо. */
export const COST = { open: 10, rough: 12, forest: 13, building: 70, locked: 120, rock: 80, water: 150, danger: 250, wall: 0 } as const;
/** Зона миномётного обстрела: проходимо, но лучше обойти. */
export const ARTILLERY_COST = 40;
/**
 * Зоны снайперов-диких: внутри карты это места их появления (на Улицах в такой зоне даже стоит
 * квестовый банкомат), а смертельные края карты отмечены в самой SVG — поэтому лишь небольшой штраф.
 */
export const SNIPER_COST = 25;
/** Метка килбокса при раскраске: клетка становится непроходимой. */
const KILLBOX = -1;

/**
 * Опасные зоны (минные поля, снайперы, обстрел) поверх сетки.
 * toGrid — перевод игровой точки в координаты сетки (дробные клетки).
 */
export function paintHazards(cost: Uint8Array, w: number, h: number, map: GameMap, toGrid: (p: { x: number; z: number }) => [number, number], classes: HazardClasses) {
    const zones: { outline: [number, number][]; value: number }[] = [];
    // килбоксы (мины, края карты) — непроходимы; «горячие» зоны внутри карты — штраф
    for (const hz of classes.killbox) zones.push({ outline: hz.outline!, value: KILLBOX });
    for (const hz of classes.heat) zones.push({ outline: hz.outline!, value: SNIPER_COST });
    for (const a of map.artillery ?? []) if (a.outline?.length) zones.push({ outline: a.outline, value: ARTILLERY_COST });
    if (!zones.length) return;
    const c = document.createElement("canvas");
    c.width = w;
    c.height = h;
    const ctx = c.getContext("2d", { willReadFrequently: true })!;
    for (const value of [SNIPER_COST, ARTILLERY_COST, KILLBOX]) {
        ctx.clearRect(0, 0, w, h);
        ctx.fillStyle = "#fff";
        for (const z of zones) {
            if (z.value !== value) continue;
            ctx.beginPath();
            z.outline.forEach(([x, zz], i) => {
                const [gx, gy] = toGrid({ x, z: zz });
                if (i) ctx.lineTo(gx, gy);
                else ctx.moveTo(gx, gy);
            });
            ctx.closePath();
            ctx.fill();
        }
        const px = ctx.getImageData(0, 0, w, h).data;
        for (let i = 0; i < w * h; i++) {
            if (px[i * 4 + 3] <= 100 || !cost[i]) continue;
            cost[i] = value === KILLBOX ? 0 : Math.max(cost[i], value);
        }
    }
}

const PALETTE: [number, number, number, number][] = [
    // r, g, b, cost
    [0, 255, 0, COST.open],
    [0, 255, 255, COST.rough],
    [0, 160, 0, COST.forest],
    [255, 255, 0, COST.building],
    [255, 128, 0, COST.locked],
    [128, 0, 255, COST.rock],
    [0, 0, 255, COST.water],
    [255, 0, 0, COST.wall],
    [0, 0, 0, COST.wall],
];
const hex = (c: number[]) => "#" + c.slice(0, 3).map((v) => v.toString(16).padStart(2, "0")).join("");
const C = Object.fromEntries(["open", "rough", "forest", "building", "locked", "rock", "water", "danger", "wall"].map((k, i) => [k, hex(PALETTE[i])])) as Record<keyof typeof COST, string>;

// Порядок важен: ниже — сильнее (перекрывает при совпадении специфичности).
export const RASTER_CSS = `
* { shape-rendering: crispEdges !important; }
text, .shadow, .powerline, .task { display: none !important; }
.cement, .tarmac, .floor, .wood, .stairs { fill: ${C.open} !important; }
.land, .gravel { fill: ${C.rough} !important; }
.road_tarmac, .road_gravel, .railroad { stroke: ${C.open} !important; stroke-dasharray: none !important; }
.trees { fill: ${C.forest} !important; }
.building { fill: ${C.building} !important; }
.locked { fill: ${C.locked} !important; }
.rock { fill: ${C.rock} !important; }
.water { fill: ${C.water} !important; }
.danger, .danger_small { fill: ${C.danger} !important; fill-opacity: 1 !important; stroke: ${C.danger} !important; }
.fence { stroke: ${C.wall} !important; stroke-width: 1.6px !important; stroke-dasharray: none !important; }
.map_border { stroke: ${C.wall} !important; stroke-width: 3px !important; }
#Limit *, #limit *, #Map_Limit *, #Border *, #Unacessible * { stroke: ${C.wall} !important; stroke-width: 3px !important; }
`;

/** Пиксели растра RASTER_CSS → стоимость клеток. */
export function classifyOutdoor(px: Uint8ClampedArray, n: number): Uint8Array {
    const cost = new Uint8Array(n);
    for (let i = 0; i < n; i++) {
        if (px[i * 4 + 3] < 128) continue; // пусто — за пределами карты
        const r = px[i * 4], g = px[i * 4 + 1], bl = px[i * 4 + 2];
        let best = COST.open as number;
        let bd = 60 * 60; // неизвестный цвет (свой цвет у элемента) — считаем проходимым
        for (const [pr, pg, pb, c] of PALETTE) {
            const dd = (r - pr) ** 2 + (g - pg) ** 2 + (bl - pb) ** 2;
            if (dd < bd) {
                bd = dd;
                best = c;
            }
        }
        cost[i] = best;
    }
    return cost;
}

export interface NavGrid {
    mapKey: string;
    w: number;
    h: number;
    cost: Uint8Array;
    cellMeters: number;
    toCell: (p: { x: number; z: number }) => number;
    toGame: (cell: number) => { x: number; z: number };
}

const MAX_CELLS = 700_000;

export async function buildNavGrid(map: GameMap, svgText: string): Promise<NavGrid> {
    const d = map.display;
    const crs = makeCRS(d);
    const b = toBounds(d.svgBounds ?? d.bounds);
    const p1 = crs.latLngToPoint(b.getNorthWest(), 0);
    const p2 = crs.latLngToPoint(b.getSouthEast(), 0);
    const rect = L.bounds(p1, p2);
    const rw = rect.max!.x - rect.min!.x;
    const rh = rect.max!.y - rect.min!.y;

    // метров на пиксель проекции и размер клетки
    const [[x1, z1], [x2, z2]] = d.svgBounds ?? d.bounds;
    const areaM = Math.abs(x1 - x2) * Math.abs(z1 - z2);
    const mPerPx = Math.sqrt(areaM / (rw * rh));
    const cellMeters = Math.max(1, Math.sqrt(areaM / MAX_CELLS));
    const w = Math.max(16, Math.round((rw * mPerPx) / cellMeters));
    const h = Math.max(16, Math.round((rh * mPerPx) / cellMeters));

    // --- подготовка SVG для растеризации ---
    const doc = new DOMParser().parseFromString(svgText, "image/svg+xml");
    const svg = doc.documentElement;
    svg.setAttribute("width", String(w));
    svg.setAttribute("height", String(h));
    svg.setAttribute("preserveAspectRatio", "none");
    for (const g of Array.from(svg.children)) {
        if (g.nodeName !== "g" || !g.id) continue;
        const keep = g.id === d.svgLayer || g.getAttribute("data-keep-with-group") === d.svgLayer;
        if (!keep) g.remove();
    }
    const style = doc.createElementNS("http://www.w3.org/2000/svg", "style");
    style.textContent = RASTER_CSS;
    svg.appendChild(style);

    const url = URL.createObjectURL(new Blob([new XMLSerializer().serializeToString(svg)], { type: "image/svg+xml" }));
    try {
        const img = new Image();
        img.decoding = "async";
        img.src = url;
        await img.decode();
        const canvas = document.createElement("canvas");
        canvas.width = w;
        canvas.height = h;
        const ctx = canvas.getContext("2d", { willReadFrequently: true })!;
        ctx.imageSmoothingEnabled = false;
        ctx.drawImage(img, 0, 0, w, h);
        const px = ctx.getImageData(0, 0, w, h).data;

        const cost = classifyOutdoor(px, w * h);
        paintHazards(
            cost,
            w,
            h,
            map,
            (p) => {
                const pt = crs.latLngToPoint(L.latLng(p.z, p.x), 0);
                return [((pt.x - rect.min!.x) / rw) * w, ((pt.y - rect.min!.y) / rh) * h];
            },
            await classifyHazards(map, svgText),
        );

        const toCell = (p: { x: number; z: number }) => {
            const pt = crs.latLngToPoint(L.latLng(p.z, p.x), 0);
            const cx = Math.min(w - 1, Math.max(0, Math.floor(((pt.x - rect.min!.x) / rw) * w)));
            const cy = Math.min(h - 1, Math.max(0, Math.floor(((pt.y - rect.min!.y) / rh) * h)));
            return cy * w + cx;
        };
        const toGame = (cell: number) => {
            const cx = (cell % w) + 0.5;
            const cy = Math.floor(cell / w) + 0.5;
            const ll = crs.pointToLatLng(L.point(rect.min!.x + (cx / w) * rw, rect.min!.y + (cy / h) * rh), 0);
            return { x: ll.lng, z: ll.lat };
        };
        return { mapKey: map.key, w, h, cost, cellMeters, toCell, toGame };
    } finally {
        URL.revokeObjectURL(url);
    }
}

// ---------------- клиент воркера ----------------

export interface MatrixResult {
    /** dist[i * n + j] — «стоимость» пути с учётом штрафов (для выбора порядка точек). */
    dist: Float64Array;
    /** len[i * n + j] — настоящая длина пути, м (Infinity — недостижимо). */
    len: Float64Array;
    /** paths[i * n + j] — клетки пути i→j (только для i < j; обратный путь — reverse). */
    paths: (Int32Array | null)[];
}

type Pending = { resolve: (v: unknown) => void; reject: (e: Error) => void };

export class PathService {
    private worker: Worker;
    private seq = 0;
    private pending = new Map<number, Pending>();
    readonly grid: NavGrid;

    constructor(grid: NavGrid) {
        this.grid = grid;
        this.worker = new Worker(new URL("./pathWorker.ts", import.meta.url), { type: "module" });
        this.worker.onmessage = (e: MessageEvent) => {
            const { id, error, result } = e.data;
            const p = this.pending.get(id);
            if (!p) return;
            this.pending.delete(id);
            if (error) p.reject(new Error(error));
            else p.resolve(result);
        };
        const cost = grid.cost.slice();
        this.worker.postMessage({ type: "init", w: grid.w, h: grid.h, cellMeters: grid.cellMeters, cost }, [cost.buffer]);
    }

    private call<T>(msg: object): Promise<T> {
        const id = ++this.seq;
        return new Promise<T>((resolve, reject) => {
            this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
            this.worker.postMessage({ ...msg, id });
        });
    }

    /** Попарные расстояния и пути между точками. */
    async matrix(points: Vec3[]): Promise<MatrixResult> {
        const cells = points.map((p) => this.grid.toCell(p));
        return this.call<MatrixResult>({ type: "matrix", cells });
    }

    /** Путь из a в b: точки в координатах игры и длина в метрах. */
    async path(a: Vec3, b: Vec3): Promise<{ points: [number, number][]; length: number } | null> {
        const r = await this.call<{ cells: Int32Array; length: number } | null>({ type: "path", from: this.grid.toCell(a), to: this.grid.toCell(b) });
        if (!r) return null;
        return { points: this.cellsToPoints(r.cells), length: r.length };
    }

    /** Линии маршрута для пар точек: точный поиск с поворотами и отступом от стен. */
    async legs(pairs: [Vec3, Vec3][]): Promise<({ points: [number, number][]; length: number } | null)[]> {
        const r = await this.call<({ cells: Int32Array; length: number } | null)[]>({
            type: "legs",
            pairs: pairs.map(([a, b]) => [this.grid.toCell(a), this.grid.toCell(b)]),
        });
        return r.map((x) => (x ? { points: this.cellsToPoints(x.cells), length: x.length } : null));
    }

    cellsToPoints(cells: Int32Array): [number, number][] {
        return Array.from(cells, (c) => {
            const g = this.grid.toGame(c);
            return [g.x, g.z] as [number, number];
        });
    }

    dispose() {
        this.worker.terminate();
        for (const p of this.pending.values()) p.reject(new Error("disposed"));
        this.pending.clear();
    }
}
