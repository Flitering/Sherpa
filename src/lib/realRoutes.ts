// Уточнение рейдов по реальным путям: порядок точек, выход, время и линии маршрута.

import type { GameMap, MapPoint, Vec3 } from "../types";
import type { PathService } from "./navgrid";
import { dist as straight, } from "./route";
import { markBest, objectiveSeconds, pmcExtracts, type Raid, type RaidPlan, type RaidSettings } from "./raids";

/** Небольшой запас на осторожность: даже по реальному пути идут не по идеальной линии. */
const CAUTION = 1.1;

export async function refineRaids(svc: PathService, map: GameMap, plan: RaidPlan, settings: RaidSettings, extractOverride?: Record<number, string>, allowed?: Set<string>): Promise<Raid[]> {
    const out: Raid[] = [];
    const pmc = pmcExtracts(map, allowed);
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
        const { dist, len, paths } = await svc.matrix(pts);
        const n = pts.length;
        const D = (a: number, b: number) => {
            const d = dist[a * n + b];
            return Number.isFinite(d) ? d : straight(pts[a], pts[b]) * 30; // недостижимо по сетке — сильный штраф
        };
        /** Метры по реальному пути; если пути нет — по прямой. */
        const M = (a: number, b: number) => {
            const m = len[a * n + b];
            return Number.isFinite(m) ? m : straight(pts[a], pts[b]);
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

        // линии маршрута: точный поиск «по-человечески» (по середине улиц, с поворотами на перекрёстках)
        const seq = [...(s0 >= 0 ? [s0] : []), ...order, ...(endBest >= 0 ? [endBest] : [])];
        const pairs = seq.slice(1).map((pi, k) => [seq[k], pi] as [number, number]);
        const human = await svc.legs(pairs.map(([x, y]) => [pts[x], pts[y]]));
        const legOf = (k: number): [number, number][] => {
            const [x, y] = pairs[k];
            const hp = human[k];
            if (!hp || hp.points.length < 2) return leg(x, y);
            const p = hp.points.slice();
            p[0] = [pts[x].x, pts[x].z];
            p[p.length - 1] = [pts[y].x, pts[y].z];
            return p;
        };
        const metersOf = (k: number) => human[k]?.length ?? M(pairs[k][0], pairs[k][1]);

        // время и линии
        const speed = settings.speed;
        let t = s0 >= 0 ? 0 : settings.approachMin * 60;
        let travelSec = t;
        let taskSec = 0;
        let lengthM = 0;
        const legs: [number, number][][] = [];
        let k = 0;
        let prev = s0;
        const steps = order.map((pi) => {
            const st = raid.steps[stepIdx.indexOf(pi)];
            if (prev >= 0) {
                const d = metersOf(k);
                const tr = (d * CAUTION) / speed;
                t += tr;
                travelSec += tr;
                lengthM += d;
                legs.push(legOf(k));
                k++;
            }
            const eta = t;
            const w = objectiveSeconds(st.stop);
            t += w;
            taskSec += w;
            prev = pi;
            return { ...st, eta };
        });
        if (endBest >= 0) {
            const d = metersOf(k);
            const tr = (d * CAUTION) / speed + 30;
            t += tr;
            travelSec += tr;
            lengthM += d;
            legs.push(legOf(k));
        }
        out.push({ ...raid, steps, extract, travelSec, taskSec, totalSec: t, legs, lengthM });
    }
    markBest(out);
    return out;
}
