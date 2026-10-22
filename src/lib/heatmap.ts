// Тепловая карта опасностей: минные поля, зоны снайперов, обстрел, стационарное оружие.
// Зоны рисуются размытыми пятнами с накоплением (где перекрываются — «горячее»),
// затем интенсивность раскрашивается палитрой и кладётся на карту одной картинкой.

import L from "leaflet";
import type { GameMap, Hazard } from "../types";
import { makeCRS, toBounds } from "./crs";

/** Сила источников (0..1) и размытие краёв, м. */
const STYLE = {
    sniper: { alpha: 0.28, blur: 9 },
    artillery: { alpha: 0.22, blur: 12 },
    other: { alpha: 0.4, blur: 6 },
};
/** Радиус «тепла» вокруг стационарного оружия, м. */
const WEAPON_RADIUS = { utes: 28, ags: 22, mg: 22 };

/** Палитра: прозрачно → жёлтый → оранжевый → красный. */
function ramp(t: number): [number, number, number, number] {
    if (t <= 0.02) return [0, 0, 0, 0];
    const stops: [number, [number, number, number, number]][] = [
        [0.0, [227, 201, 107, 0]],
        [0.2, [227, 201, 107, 45]],
        [0.45, [255, 154, 61, 85]],
        [0.75, [255, 90, 50, 125]],
        [1.0, [220, 30, 30, 165]],
    ];
    for (let i = 1; i < stops.length; i++) {
        const [t1, c1] = stops[i];
        const [t0, c0] = stops[i - 1];
        if (t <= t1) {
            const k = (t - t0) / (t1 - t0);
            return [0, 1, 2, 3].map((j) => Math.round(c0[j] + (c1[j] - c0[j]) * k)) as [number, number, number, number];
        }
    }
    return stops[stops.length - 1][1];
}

export interface Heatmap {
    url: string;
    bounds: L.LatLngBounds;
}

export function buildHeatmap(map: GameMap, heatZones: Hazard[]): Heatmap | null {
    const has = heatZones.length || map.artillery.some((a) => a.outline?.length) || map.stationary.length;
    if (!has) return null;

    const d = map.display;
    const crs = makeCRS(d);
    const bounds = toBounds(d.svgBounds ?? d.bounds);
    const p1 = crs.latLngToPoint(bounds.getNorthWest(), 0);
    const p2 = crs.latLngToPoint(bounds.getSouthEast(), 0);
    const rect = L.bounds(p1, p2);
    const rw = rect.max!.x - rect.min!.x;
    const rh = rect.max!.y - rect.min!.y;
    const [[x1, z1], [x2, z2]] = d.svgBounds ?? d.bounds;
    const mPerProj = Math.sqrt((Math.abs(x1 - x2) * Math.abs(z1 - z2)) / (rw * rh));
    const widthM = rw * mPerProj;
    // ~1 пиксель на метр, но не больше 1400 по стороне
    const scale = Math.min(1, 1400 / Math.max(widthM, (widthM * rh) / rw));
    const w = Math.max(64, Math.round(widthM * scale));
    const h = Math.max(64, Math.round((w * rh) / rw));
    const pxPerM = w / widthM;
    const toPx = (p: { x: number; z: number }): [number, number] => {
        const pt = crs.latLngToPoint(L.latLng(p.z, p.x), 0);
        return [((pt.x - rect.min!.x) / rw) * w, ((pt.y - rect.min!.y) / rh) * h];
    };

    // 1. интенсивность: белые пятна с накоплением
    const c = document.createElement("canvas");
    c.width = w;
    c.height = h;
    const ctx = c.getContext("2d", { willReadFrequently: true })!;
    ctx.globalCompositeOperation = "lighter";
    const poly = (outline: [number, number][], alpha: number, blurM: number) => {
        ctx.filter = `blur(${Math.max(1, blurM * pxPerM)}px)`;
        ctx.fillStyle = `rgba(255,255,255,${alpha})`;
        ctx.beginPath();
        outline.forEach(([x, z], i) => {
            const [px, py] = toPx({ x, z });
            if (i) ctx.lineTo(px, py);
            else ctx.moveTo(px, py);
        });
        ctx.closePath();
        ctx.fill();
    };
    for (const a of map.artillery) if (a.outline) poly(a.outline, STYLE.artillery.alpha, STYLE.artillery.blur);
    for (const hz of heatZones) {
        if (!hz.outline) continue;
        const s = hz.type === "sniper" ? STYLE.sniper : STYLE.other;
        poly(hz.outline, s.alpha, s.blur);
    }
    ctx.filter = "none";
    for (const st of map.stationary) {
        const [px, py] = toPx(st.position);
        const r = WEAPON_RADIUS[st.type] * pxPerM;
        const g = ctx.createRadialGradient(px, py, 0, px, py, r);
        g.addColorStop(0, "rgba(255,255,255,0.45)");
        g.addColorStop(1, "rgba(255,255,255,0)");
        ctx.fillStyle = g;
        ctx.beginPath();
        ctx.arc(px, py, r, 0, Math.PI * 2);
        ctx.fill();
    }

    // 2. раскраска палитрой
    const img = ctx.getImageData(0, 0, w, h);
    const px = img.data;
    for (let i = 0; i < px.length; i += 4) {
        // при сложении «lighter» интенсивность накапливается в прозрачности
        const t = Math.min(1, px[i + 3] / 255);
        const [r, g, b, a] = ramp(t);
        px[i] = r;
        px[i + 1] = g;
        px[i + 2] = b;
        px[i + 3] = a;
    }
    ctx.putImageData(img, 0, 0);
    return { url: c.toDataURL("image/png"), bounds };
}

// по самому объекту карты: у PvP и PvE свои данные, ключ по имени их смешивал
const cache = new WeakMap<GameMap, Heatmap | null>();
export function heatmapFor(map: GameMap, heatZones: Hazard[]): Heatmap | null {
    if (!cache.has(map)) cache.set(map, buildHeatmap(map, heatZones));
    return cache.get(map)!;
}
