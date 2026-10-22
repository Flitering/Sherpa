// Разбиение целей карты на рейды: районы + реалистичная оценка времени.
//
// 1. Строим один общий обход всех точек (ближайший сосед + 2-opt) — соседние в обходе
//    точки географически близки.
// 2. Режем обход на непрерывные куски так, чтобы каждый кусок укладывался в бюджет
//    времени рейда (динамическое программирование: минимум рейдов, затем минимум времени).
// 3. Для каждого куска заново строим маршрут: от ближайшего спавна до ближайшего выхода.
// 4. Называем рейд по ближайшим подписям карты (районам).

import type { GameMap, MapPoint, Vec3 } from "../types";
import { labelRu } from "./labels-ru";
import type { Stop } from "./quests";
import { dist, planRoute } from "./route";

export interface RaidSettings {
    /** Средняя скорость с учётом осторожного движения, м/с. */
    speed: number;
    /** Во сколько раз реальный путь длиннее прямой (обход зданий, заборов). */
    detour: number;
    /** Какую долю времени рейда можно планировать (остальное — бой, лут, запас). */
    budgetShare: number;
    /** Время от спавна до первой точки, если спавны карты неизвестны, мин. */
    approachMin: number;
}

export const DEFAULT_RAID_SETTINGS: RaidSettings = { speed: 2.2, detour: 1.35, budgetShare: 0.6, approachMin: 2 };

/** Сколько секунд занимает цель на месте. */
const OBJECTIVE_SECONDS: Record<string, number> = {
    visit: 25,
    mark: 40,
    plantItem: 50,
    plantQuestItem: 50,
    findQuestItem: 70,
    useItem: 40,
    shoot: 240,
    findItem: 60,
};

export function objectiveSeconds(s: Stop): number {
    const base = OBJECTIVE_SECONDS[s.objective.type] ?? 40;
    // Квестовый предмет может лежать в нескольких местах — закладываем осмотр пары соседних.
    const extra = s.objective.type === "findQuestItem" ? Math.min(s.points.length - 1, 2) * 35 : 0;
    return base + extra;
}

export const RAID_COLORS = ["#d8b45a", "#5fb4d6", "#94c95d", "#d9708f", "#ae92e6", "#e3904f", "#5fd1b0", "#c9c45a"];

export interface RaidStep {
    stop: Stop;
    point: Vec3;
    /** Время прибытия от начала рейда, с. */
    eta: number;
}

export interface Raid {
    index: number;
    color: string;
    name: string;
    steps: RaidStep[];
    spawn?: Vec3;
    extract?: MapPoint;
    /** Оценка, с: дорога, задания, весь рейд. */
    travelSec: number;
    taskSec: number;
    totalSec: number;
    shared: number;
    /** Самый выгодный рейд по числу целей в минуту (с учётом выбранных выходов). */
    best?: boolean;
    /** Реальные пути по сетке проходимости: спавн→1, 1→2, …, последняя→выход. */
    legs?: [number, number][][];
    /** Длина пути по сетке, м. */
    lengthM?: number;
}

export interface RaidPlan {
    raids: Raid[];
    budgetSec: number;
    raidSec: number;
}

/** Выходы ЧВК; если задан список доступных в этом рейде — только они (пустой выбор = все). */
export function pmcExtracts(m: GameMap, allowed?: Set<string>) {
    const all = m.extracts.filter((e) => e.faction !== "scav");
    if (!allowed) return all;
    const only = all.filter((e) => allowed.has(e.name));
    return only.length ? only : all;
}

function nearest<T extends { position: Vec3 }>(list: T[], p: Vec3): T | undefined {
    let best: T | undefined;
    let d = Infinity;
    for (const x of list) {
        const dd = dist(x.position, p);
        if (dd < d) {
            d = dd;
            best = x;
        }
    }
    return best;
}

function districtName(map: GameMap, points: Vec3[]): string {
    const labels = map.display.labels.filter((l) => l.size >= 60 || map.display.labels.length < 30);
    if (!labels.length) return "";
    const score = new Map<string, number>();
    for (const p of points) {
        let best: string | undefined;
        let d = Infinity;
        for (const l of labels) {
            const dd = Math.hypot(l.x - p.x, l.z - p.z);
            if (dd < d) {
                d = dd;
                best = l.text;
            }
        }
        if (best) score.set(best, (score.get(best) ?? 0) + 1);
    }
    return [...score.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 2)
        .map(([t]) => labelRu(t))
        .join(" · ");
}

export function planRaids(map: GameMap, stops: Stop[], settings: RaidSettings, extractOverride?: Record<number, string>, allowed?: Set<string>): RaidPlan {
    const raidSec = (map.raidDuration ?? 40) * 60;
    const budgetSec = raidSec * settings.budgetShare;
    const travel = (a: Vec3, b: Vec3) => (dist(a, b) * settings.detour) / settings.speed;
    const extracts = pmcExtracts(map, allowed);
    const spawns = map.spawns;

    const approach = (p: Vec3) => {
        const s = spawns.length ? nearest(spawns, p) : undefined;
        return s ? travel(s.position, p) : settings.approachMin * 60;
    };
    const exitCost = (p: Vec3) => {
        const e = nearest(extracts, p);
        return (e ? travel(p, e.position) : 120) + 30;
    };

    if (!stops.length) return { raids: [], budgetSec, raidSec };

    // 1. общий обход
    const tour = planRoute(stops.map((s) => ({ stop: s, candidates: s.points.map((p) => p.position) }))).order;
    const n = tour.length;
    const work = tour.map((t) => objectiveSeconds(t.stop));

    // стоимость куска [i, j]
    const cost = (i: number, j: number) => {
        let t = approach(tour[i].point) + exitCost(tour[j].point);
        for (let k = i; k <= j; k++) {
            t += work[k];
            if (k > i) t += travel(tour[k - 1].point, tour[k].point);
        }
        return t;
    };

    // 2. DP: best[j] = [рейдов, время] для первых j точек
    const best: { raids: number; time: number; from: number }[] = [{ raids: 0, time: 0, from: -1 }];
    for (let j = 1; j <= n; j++) {
        let cur = { raids: Infinity, time: Infinity, from: j - 1 };
        for (let i = j - 1; i >= 0; i--) {
            const c = cost(i, j - 1);
            // одиночная точка допускается, даже если не влезает в бюджет
            if (c > budgetSec && i < j - 1) break;
            const cand = { raids: best[i].raids + 1, time: best[i].time + c, from: i };
            if (cand.raids < cur.raids || (cand.raids === cur.raids && cand.time < cur.time)) cur = cand;
        }
        best.push(cur);
    }
    const cuts: [number, number][] = [];
    for (let j = n; j > 0; j = best[j].from) cuts.unshift([best[j].from, j - 1]);

    // 3. маршрут внутри каждого рейда
    const raids: Raid[] = cuts.map(([i, j]) => {
        const group = tour.slice(i, j + 1).map((t) => t.stop);
        const center = tour[Math.floor((i + j) / 2)].point;
        const firstGuess = tour[i].point;
        const spawn = spawns.length ? nearest(spawns, firstGuess)?.position : undefined;
        let extract = nearest(extracts, tour[j].point);
        const route = planRoute(
            group.map((s) => ({ stop: s, candidates: s.points.map((p) => p.position) })),
            spawn,
            extract?.position,
        );
        // выход — ближайший к последней точке уже оптимизированного маршрута
        const last = route.order[route.order.length - 1]?.point ?? center;
        extract = nearest(extracts, last);
        return { group, route, spawn, extract };
    }).map(({ route, spawn, extract }, index) => {
        let t = spawn ? 0 : settings.approachMin * 60;
        let travelSec = spawn ? 0 : t;
        let taskSec = 0;
        let prev = spawn;
        const steps: RaidStep[] = route.order.map((o) => {
            if (prev) {
                const tr = travel(prev, o.point);
                t += tr;
                travelSec += tr;
            }
            const eta = t;
            const w = objectiveSeconds(o.stop);
            t += w;
            taskSec += w;
            prev = o.point;
            return { stop: o.stop, point: o.point, eta };
        });
        if (prev && extract) {
            const tr = travel(prev, extract.position) + 30;
            t += tr;
            travelSec += tr;
        }
        return {
            index,
            color: RAID_COLORS[index % RAID_COLORS.length],
            name: districtName(map, steps.map((s) => s.point)) || `Рейд ${index + 1}`,
            steps,
            spawn,
            extract,
            travelSec,
            taskSec,
            totalSec: t,
            shared: steps.filter((s) => s.stop.players.length > 1).length,
        };
    });

    // 4. порядок рейдов: сначала где больше общих целей, затем где больше целей в минуту
    raids.sort((a, b) => b.shared - a.shared || b.steps.length / b.totalSec - a.steps.length / a.totalSec);
    raids.forEach((r, i) => {
        r.index = i;
        r.color = RAID_COLORS[i % RAID_COLORS.length];
        // ручной выбор выхода (по номеру рейда в итоговом порядке)
        const name = extractOverride?.[i];
        const e = name ? map.extracts.find((x) => x.name === name) ?? map.transits.find((x) => x.name === name) : undefined;
        if (e) {
            const last = r.steps[r.steps.length - 1]?.point;
            if (last && r.extract) r.totalSec += travel(last, e.position) - travel(last, r.extract.position);
            r.extract = e;
        }
    });
    markBest(raids);
    return { raids, budgetSec, raidSec };
}

/** Отметить рейд с наибольшим числом целей в минуту. */
export function markBest(raids: Raid[]) {
    let best: Raid | undefined;
    for (const r of raids) {
        r.best = false;
        if (r.steps.length && (!best || r.steps.length / r.totalSec > best.steps.length / best.totalSec)) best = r;
    }
    if (best && raids.length > 1) best.best = true;
}

export const fmtMin = (sec: number) => `${Math.max(1, Math.round(sec / 60))} мин`;

/**
 * План от настоящей точки спавна (известна по первому скриншоту в рейде).
 * Рейд «отсюда»: жадно добавляем цели с наименьшим приростом времени (вставка в лучшее место маршрута,
 * общие для группы цели дешевле), пока весь путь до выхода укладывается в бюджет. Порядок затем
 * улучшается 2-opt от спавна к выходу. Оставшиеся цели — обычное разбиение на будущие рейды.
 */
export function planWithSpawn(
    map: GameMap,
    stops: Stop[],
    settings: RaidSettings,
    spawn: Vec3,
    extractOverride?: Record<number, string>,
    allowed?: Set<string>,
): RaidPlan {
    const raidSec = (map.raidDuration ?? 40) * 60;
    const budgetSec = raidSec * settings.budgetShare;
    const travel = (a: Vec3, b: Vec3) => (dist(a, b) * settings.detour) / settings.speed;
    const extracts = pmcExtracts(map, allowed);
    const exitCost = (p: Vec3) => {
        const e = nearest(extracts, p);
        return (e ? travel(p, e.position) : 120) + 30;
    };
    if (!stops.length) return { raids: [], budgetSec, raidSec };

    // жадная вставка
    type Node = { stop: Stop; point: Vec3 };
    const route: Node[] = [];
    let total = exitCost(spawn);
    const left = new Set(stops);
    for (;;) {
        let best: { stop: Stop; point: Vec3; at: number; delta: number; score: number } | undefined;
        for (const s of left) {
            const work = objectiveSeconds(s);
            for (const c of s.points) {
                const p = c.position;
                for (let k = 0; k <= route.length; k++) {
                    const prev = k === 0 ? spawn : route[k - 1].point;
                    let delta = work + travel(prev, p);
                    if (k < route.length) delta += travel(p, route[k].point) - travel(prev, route[k].point);
                    else delta += exitCost(p) - exitCost(prev);
                    // общая для нескольких игроков цель выгоднее
                    const score = delta / (1 + 0.5 * (s.players.length - 1));
                    if (!best || score < best.score) best = { stop: s, point: p, at: k, delta, score };
                }
            }
        }
        if (!best || total + best.delta > budgetSec) break;
        route.splice(best.at, 0, { stop: best.stop, point: best.point });
        total += best.delta;
        left.delete(best.stop);
    }
    // если даже одна цель не влезает — всё равно берём ближайшую
    if (!route.length) {
        const s = stops.reduce((a, b) => (dist(spawn, a.points[0].position) <= dist(spawn, b.points[0].position) ? a : b));
        route.push({ stop: s, point: s.points[0].position });
        left.delete(s);
    }

    // порядок от спавна к выходу
    const group = route.map((n) => n.stop);
    let extract = nearest(extracts, route[route.length - 1].point);
    const ordered = planRoute(
        group.map((s) => ({ stop: s, candidates: s.points.map((p) => p.position) })),
        spawn,
        extract?.position,
    );
    const last = ordered.order[ordered.order.length - 1]?.point ?? spawn;
    extract = nearest(extracts, last);
    const forced = extractOverride?.[0];
    const fe = forced ? map.extracts.find((x) => x.name === forced) ?? map.transits.find((x) => x.name === forced) : undefined;
    if (fe) extract = fe;

    let t = 0;
    let travelSec = 0;
    let taskSec = 0;
    let prev = spawn;
    const steps: RaidStep[] = ordered.order.map((o) => {
        const tr = travel(prev, o.point);
        t += tr;
        travelSec += tr;
        const eta = t;
        const w = objectiveSeconds(o.stop);
        t += w;
        taskSec += w;
        prev = o.point;
        return { stop: o.stop, point: o.point, eta };
    });
    if (extract) {
        const tr = travel(prev, extract.position) + 30;
        t += tr;
        travelSec += tr;
    }
    const here: Raid = {
        index: 0,
        color: RAID_COLORS[0],
        name: `От спавна · ${districtName(map, steps.map((s) => s.point)) || "рядом"}`,
        steps,
        spawn,
        extract,
        travelSec,
        taskSec,
        totalSec: t,
        shared: steps.filter((s) => s.stop.players.length > 1).length,
    };

    // остальные цели — следующие рейды (номера ручных выходов сдвинуты на один)
    const shifted: Record<number, string> = {};
    for (const [k, v] of Object.entries(extractOverride ?? {})) if (+k > 0) shifted[+k - 1] = v;
    const rest = planRaids(map, [...left], settings, shifted, allowed);
    const raids = [here, ...rest.raids];
    raids.forEach((r, i) => {
        r.index = i;
        r.color = RAID_COLORS[i % RAID_COLORS.length];
        r.best = false;
    });
    here.best = true; // сейчас ты здесь — этот рейд и предлагаем
    return { raids, budgetSec, raidSec };
}
