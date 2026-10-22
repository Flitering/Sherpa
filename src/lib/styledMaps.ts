// Схемы растровых карт (Лаборатория, Лабиринт, Ледокол), перекрашенные в стиль остальных карт.
// Готовятся при обновлении данных (electron/stylemaps.mjs); привязаны к сетке тайлов tarkov.dev.

import L from "leaflet";
import type { MapDisplay } from "../types";
import { makeCRS } from "./crs";
import { dataUrl } from "./desktop";

export interface StyledEntry {
    file: string;
    z: number;
    x0: number;
    y0: number;
    nx: number;
    ny: number;
    ts: number;
}

let index: Promise<Record<string, StyledEntry>> | null = null;

/** Индекс схем по шаблону адреса тайлов слоя. */
export function loadStyled(): Promise<Record<string, StyledEntry>> {
    if (!index)
        index = fetch(dataUrl("maps/styled/index.json"))
            .then((r) => (r.ok ? r.json() : {}))
            .catch(() => ({}));
    return index;
}

/** Сбросить после обновления данных. */
export function resetStyled() {
    index = null;
}

export const styledUrl = (e: StyledEntry) => dataUrl(e.file);

/** Границы картинки на карте: тайл (x, y) зума z занимает пиксели [x·ts, (x+1)·ts] проекции. */
export function styledBounds(display: MapDisplay, e: StyledEntry): L.LatLngBounds {
    const crs = makeCRS(display);
    return L.latLngBounds(crs.pointToLatLng(L.point(e.x0 * e.ts, e.y0 * e.ts), e.z), crs.pointToLatLng(L.point((e.x0 + e.nx) * e.ts, (e.y0 + e.ny) * e.ts), e.z));
}
