// Уточнение рейдов по реальным путям: порядок точек, выход, время и линии маршрута.

import type { GameMap, MapPoint, Vec3 } from "../types";
import type { PathService } from "./navgrid";
import { dist as straight, } from "./route";
import { objectiveSeconds, type Raid, type RaidPlan, type RaidSettings } from "./raids";

/** Небольшой запас на осторожность: даже по реальному пути идут не по идеальной линии. */
const CAUTION = 1.1;

export async function refineRaids(svc: PathService, map: GameMap, plan: RaidPlan, settings: RaidSettings, extractOverride?: Record<number, string>): Promise<Raid[]> {
    const out: Raid[] = [];
    const pmc = map.extracts.filter((e) => e.faction !== "scav");
    for (const raid of plan.raids) {
        if (!raid.steps.length) {
            out.push(raid);
            continue;
        }
        const forced = extractOverride?.[raid.index] ? raid.extract : undefined;
        const last = raid.steps[raid.steps.length - 1].point;
        const endCands: MapPoint[] = forced ? [forced] : [...pmc].sort((a, b) => straight(a.position, last) - straight(b.position, last)).slice(0, 4);

        // точки: [спавн?] шаги… выходы…
        const pts: Vec3[] = [];
        const s0 = raid.spawn ? (pts.push(raid.spawn), 0) : -1;
        const stepIdx = raid.steps.map((st) => pts.push(st.point) - 1);
        const endIdx = endCands.map((e) => pts.push(e.position) - 1);
        const { dist, paths } = await svc.matrix(pts);
        const n = pts.length;
        const D = (a: number, b: number) => {
            const d = dist[a * n + b];
            return Number.isFinite(d) ? d : straight(pts[a], pts[b]) * 3; // недостижимо по сетке — штраф
        };

        // порядок: 2-opt + перенос одной точки, на настоящих расстояниях
        let order = stepIdx.slice();
        const total = (o: number[]) => {
            let t = s0 >= 0 ? D(s0, o[0]) : 0;
            for (let k = 1; k < o.length; k++) t += D(o[k - 1], o[k]);
            return t + Math.min(...endIdx.map((e) => D(o[o.length - 1], e)), Infinity);
        };
        let best = total(order);
        for (let iter = 0, improved = true; improved && iter < 40; iter++) {
            improved = false;
            for (let a = 0; a < order.length - 1; a++) {
                for (let b = a + 1; b < order.length; b++) {
                    const cand = order.slice(0, a).concat(order.slice(a, b + 1).reverse(), order.slice(b + 1));
                    const t = total(cand);
                    if (t + 0.01 < best) {
                        best = t;
                        order = cand;
                        improved = true;
                    }
                }
            }
            for (let a = 0; a < order.length; a++) {
                for (let b = 0; b < order.length; b++) {
                    if (a === b) continue;
                    const cand = order.slice();
                    const [x] = cand.splice(a, 1);
                    cand.splice(b, 0, x);
                    const t = total(cand);
                    if (t + 0.01 < best) {
                        best = t;
                        order = cand;
                        improved = true;
                    }
                }
            }
        }
        const lastIdx = order[order.length - 1];
        const endBest = endIdx.length ? endIdx.reduce((a, b) => (D(lastIdx, a) <= D(lastIdx, b) ? a : b)) : -1;
        const extract = endBest >= 0 ? endCands[endIdx.indexOf(endBest)] : raid.extract;

        const leg = (a: number, b: number): [number, number][] => {
            const i = Math.min(a, b);
            const j = Math.max(a, b);
            const cells = paths[i * n + j];
            if (!cells) return [
                [pts[a].x, pts[a].z],
                [pts[b].x, pts[b].z],
            ];
            const p = svc.cellsToPoints(cells);
            if (a > b) p.reverse();
            // концы — точно в точки, а не в центры клеток
            p[0] = [pts[a].x, pts[a].z];
            p[p.length - 1] = [pts[b].x, pts[b].z];
            return p;
        };

        // время и линии
        const speed = settings.speed;
        let t = s0 >= 0 ? 0 : settings.approachMin * 60;
        let travelSec = t;
        let taskSec = 0;
        let lengthM = 0;
        const legs: [number, number][][] = [];
        let prev = s0;
        const steps = order.map((pi) => {
            const st = raid.steps[stepIdx.indexOf(pi)];
            if (prev >= 0) {
                const d = D(prev, pi);
                const tr = (d * CAUTION) / speed;
                t += tr;
                travelSec += tr;
                lengthM += d;
                legs.push(leg(prev, pi));
            }
            const eta = t;
            const w = objectiveSeconds(st.stop);
            t += w;
            taskSec += w;
            prev = pi;
            return { ...st, eta };
        });
        if (endBest >= 0) {
            const d = D(prev, endBest);
            const tr = (d * CAUTION) / speed + 30;
            t += tr;
            travelSec += tr;
            lengthM += d;
            legs.push(leg(prev, endBest));
        }
        out.push({ ...raid, steps, extract, travelSec, taskSec, totalSec: t, legs, lengthM });
    }
    return out;
}
