// Привязка игровых координат к карте Leaflet.
// Логика повторяет tarkov.dev: точка игры (x, z) → LatLng(z, x), затем поворот
// на coordinateRotation и линейное преобразование transform из конфигурации карты.

import L from "leaflet";
import type { LayerExtent, MapDisplay, Vec3 } from "../types";

function rotate(latLng: L.LatLng, rotation: number): L.LatLng {
    if (!rotation || (!latLng.lat && !latLng.lng)) return latLng;
    const a = (rotation * Math.PI) / 180;
    const cos = Math.cos(a);
    const sin = Math.sin(a);
    const { lng: x, lat: y } = latLng;
    return L.latLng(x * sin + y * cos, x * cos - y * sin);
}

export function makeCRS(d: MapDisplay): L.CRS {
    const [scaleX, marginX, scaleY, marginY] = d.transform ?? [1, 0, 1, 0];
    return L.extend({}, L.CRS.Simple, {
        transformation: new L.Transformation(scaleX, marginX, -scaleY, marginY),
        projection: L.extend({}, L.Projection.LonLat, {
            project: (latLng: L.LatLng) => L.Projection.LonLat.project(rotate(latLng, d.coordinateRotation)),
            unproject: (point: L.Point) => rotate(L.Projection.LonLat.unproject(point), -d.coordinateRotation),
        }),
    }) as L.CRS;
}

/** Игровая точка → LatLng. */
export const toLatLng = (p: { x: number; z: number }): L.LatLngTuple => [p.z, p.x];

/** Границы из конфигурации ([[x1, z1], [x2, z2]]) → LatLngBounds. */
export const toBounds = (b: [[number, number], [number, number]]) =>
    L.latLngBounds([b[0][1], b[0][0]], [b[1][1], b[1][0]]);

/** LatLng → игровые x/z (для точки старта, поставленной кликом). */
export const fromLatLng = (ll: L.LatLng): Vec3 => ({ x: ll.lng, y: 0, z: ll.lat });

/** Находится ли точка на выбранном этаже. extents = undefined → все этажи. */
export function onLevel(p: Vec3, extents: LayerExtent[] | undefined, top?: number, bottom?: number): boolean {
    if (!extents) return true;
    const hi = top ?? p.y;
    const lo = bottom ?? p.y;
    return extents.some((e) => {
        if (!(hi >= e.height[0] && lo < e.height[1])) return false;
        if (!e.bounds) return true;
        return e.bounds.some((b) => toBounds(b).contains(toLatLng(p)));
    });
}
