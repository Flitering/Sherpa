// Порядок обхода точек: жадный ближайший сосед + улучшение 2-opt.
// У каждой остановки может быть несколько точек-альтернатив (например, места
// появления квестового предмета) — выбирается та, что ближе к соседям.
// Расстояние считается по прямой, со штрафом за перепад высоты (этажи).
// Стены, заборы и опасные зоны не учитываются — маршрут ориентировочный.

import type { Vec3 } from "../types";

const VERTICAL_PENALTY = 3;

export function dist(a: Vec3, b: Vec3): number {
    const dx = a.x - b.x;
    const dz = a.z - b.z;
    return Math.hypot(dx, dz) + Math.abs(a.y - b.y) * VERTICAL_PENALTY;
}

export interface RouteInput<T> {
    stop: T;
    candidates: Vec3[];
}

export interface RouteResult<T> {
    order: { stop: T; point: Vec3; index: number }[];
    length: number;
}

/** Длина ломаной `start → точки → end`, м; концы без координат в конце и начале не считаются. */
export function pathLength(points: Vec3[], start?: Vec3, end?: Vec3): number {
    let d = 0;
    let prev = start;
    for (const p of points) {
        if (prev) d += dist(prev, p);
        prev = p;
    }
    if (end && prev) d += dist(prev, end);
    return d;
}

export function planRoute<T>(stops: RouteInput<T>[], start?: Vec3, end?: Vec3): RouteResult<T> {
    if (!stops.length) return { order: [], length: 0 };

    // 1. Жадно: из текущей точки идём к ближайшей альтернативе любой непосещённой остановки.
    const left = stops.map((s, i) => ({ ...s, i }));
    const seq: { i: number; c: number }[] = [];
    let cur = start ?? stops[0].candidates[0];
    while (left.length) {
        let best = { li: 0, c: 0, d: Infinity };
        left.forEach((s, li) =>
            s.candidates.forEach((p, c) => {
                const d = dist(cur, p);
                if (d < best.d) best = { li, c, d };
            }),
        );
        const s = left.splice(best.li, 1)[0];
        seq.push({ i: s.i, c: best.c });
        cur = s.candidates[best.c];
    }

    const point = (k: { i: number; c: number }) => stops[k.i].candidates[k.c];
    const seqPts: Vec3[] = [];
    const total = () => {
        seqPts.length = 0;
        for (const k of seq) seqPts.push(point(k));
        return pathLength(seqPts, start, end);
    };

    // 2. Чередуем 2-opt (переворот отрезков) и перевыбор альтернатив, пока есть улучшения.
    for (let iter = 0; iter < 30; iter++) {
        let improved = false;
        const n = seq.length;
        for (let a = 0; a < n - 1; a++) {
            for (let b = a + 1; b < n; b++) {
                const before = total();
                reverse(seq, a, b);
                if (total() + 1e-6 < before) improved = true;
                else reverse(seq, a, b);
            }
        }
        for (let k = 0; k < n; k++) {
            const prev = k > 0 ? point(seq[k - 1]) : start;
            const next = k < n - 1 ? point(seq[k + 1]) : end;
            const cands = stops[seq[k].i].candidates;
            let bestC = seq[k].c;
            let bestD = Infinity;
            cands.forEach((p, c) => {
                const d = (prev ? dist(prev, p) : 0) + (next ? dist(p, next) : 0);
                if (d < bestD) {
                    bestD = d;
                    bestC = c;
                }
            });
            if (bestC !== seq[k].c) {
                seq[k].c = bestC;
                improved = true;
            }
        }
        if (!improved) break;
    }

    return {
        order: seq.map((k, index) => ({ stop: stops[k.i].stop, point: point(k), index })),
        length: total(),
    };
}

function reverse<T>(arr: T[], a: number, b: number) {
    while (a < b) {
        [arr[a], arr[b]] = [arr[b], arr[a]];
        a++;
        b--;
    }
}
