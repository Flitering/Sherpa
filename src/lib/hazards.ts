// Какие опасные зоны — килбоксы (туда ходить нельзя), а какие — «горячие» места внутри карты.
//
// Килбоксы: все минные поля и снайперские зоны у края карты — они выходят за нарисованную
// область или прижаты к границе. Снайперские зоны внутри карты (на Улицах — перекрёстки,
// где работают снайперы-дикие) остаются тепловой картой: ходить можно, но опасно.

import L from "leaflet";
import type { GameMap, Hazard } from "../types";
import { makeCRS, toBounds } from "./crs";

/** Доля площади зоны за пределами нарисованной карты, после которой зона считается краевой. */
const OUTSIDE_SHARE = 0.05;
/** Зона, прижатая к границе данных ближе этого, — тоже краевая, м. */
const EDGE_M = 25;

function inside(x: number, z: number, poly: [number, number][]) {
    let c = false;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
        const [xi, zi] = poly[i];
        const [xj, zj] = poly[j];
        if (zi > z !== zj > z && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) c = !c;
    }
    return c;
}

/** Маска «внутри нарисованной карты» по альфа-каналу основного слоя SVG. */
async function drawnMask(map: GameMap, svgText: string) {
    const d = map.display;
    const crs = makeCRS(d);
    const bounds = toBounds(d.svgBounds ?? d.bounds);
    const p1 = crs.latLngToPoint(bounds.getNorthWest(), 0);
    const p2 = crs.latLngToPoint(bounds.getSouthEast(), 0);
    const rect = L.bounds(p1, p2);
    const rw = rect.max!.x - rect.min!.x;
    const rh = rect.max!.y - rect.min!.y;
    const w = 600;
    const h = Math.round((w * rh) / rw);
    const doc = new DOMParser().parseFromString(svgText, "image/svg+xml");
    const svg = doc.documentElement;
    svg.setAttribute("width", String(w));
    svg.setAttribute("height", String(h));
    svg.setAttribute("preserveAspectRatio", "none");
    for (const g of Array.from(svg.children)) {
        if (g.nodeName === "g" && g.id && g.id !== d.svgLayer && g.getAttribute("data-keep-with-group") !== d.svgLayer) g.remove();
    }
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
        const a = ctx.getImageData(0, 0, w, h).data;
        return (x: number, z: number) => {
            const pt = crs.latLngToPoint(L.latLng(z, x), 0);
            const px = Math.floor(((pt.x - rect.min!.x) / rw) * w);
            const py = Math.floor(((pt.y - rect.min!.y) / rh) * h);
            if (px < 0 || py < 0 || px >= w || py >= h) return false;
            return a[(py * w + px) * 4 + 3] > 40;
        };
    } finally {
        URL.revokeObjectURL(url);
    }
}

export interface HazardClasses {
    /** Килбоксы: нельзя ходить, рисуются чёткими блоками. */
    killbox: Hazard[];
    /** «Горячие» зоны внутри карты: тепловая карта, небольшой штраф маршруту. */
    heat: Hazard[];
}

const cache = new Map<string, Promise<HazardClasses>>();

export function classifyHazards(map: GameMap, svgText: string | null): Promise<HazardClasses> {
    const key = map.key + (svgText ? "" : ":nosvg");
    let p = cache.get(key);
    if (!p) {
        p = (async () => {
            const drawn = svgText ? await drawnMask(map, svgText).catch(() => null) : null;
            const [[x1, z1], [x2, z2]] = map.display.bounds;
            const xmin = Math.min(x1, x2), xmax = Math.max(x1, x2), zmin = Math.min(z1, z2), zmax = Math.max(z1, z2);
            const out: HazardClasses = { killbox: [], heat: [] };
            for (const h of map.hazards) {
                if (!h.outline?.length) continue;
                if (h.type !== "sniper") {
                    out.killbox.push(h); // минные поля и прочие ловушки
                    continue;
                }
                const nearEdge = h.outline.some(([x, z]) => Math.min(x - xmin, xmax - x, z - zmin, zmax - z) < EDGE_M);
                let outsideShare = 0;
                if (drawn) {
                    const xs = h.outline.map((p) => p[0]);
                    const zs = h.outline.map((p) => p[1]);
                    const step = Math.max(2, Math.sqrt(((Math.max(...xs) - Math.min(...xs)) * (Math.max(...zs) - Math.min(...zs))) / 400));
                    let inPoly = 0;
                    let outside = 0;
                    for (let x = Math.min(...xs); x <= Math.max(...xs); x += step) {
                        for (let z = Math.min(...zs); z <= Math.max(...zs); z += step) {
                            if (!inside(x, z, h.outline)) continue;
                            inPoly++;
                            if (!drawn(x, z)) outside++;
                        }
                    }
                    outsideShare = inPoly ? outside / inPoly : 0;
                }
                (nearEdge || outsideShare >= OUTSIDE_SHARE ? out.killbox : out.heat).push(h);
            }
            return out;
        })();
        cache.set(key, p);
    }
    return p;
}
