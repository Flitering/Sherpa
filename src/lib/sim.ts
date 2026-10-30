import type { Vec3 } from "../types";
import type { Raid } from "./raids";
import type { PlayerFix } from "./navigator";

/**
 * Симулятор движения игрока (отладка). Настоящий рейд снять сложно: игрок в игре, а маршрут
 * нужно проверять и на шуме координат, и на обходе цели, и на «развернулся назад». Поэтому
 * позиции здесь рисуются сами, но подаются в то же состояние, что и разбор имён файлов
 * скриншотов, — дальше приложение не видит разницы: карта, стрелка, путь по сетке и
 * перестроение маршрута под позицию работают как обычно.
 */

export type SimMode = "route" | "reverse" | "circle" | "wander";

export interface SimCfg {
    mode: SimMode;
    /** м/с: 6.5 — бег, 30–45 — перемотка, чтобы перестроения успевали случаться чаще */
    speed: number;
    /** как часто появляется новая позиция, с (1 с — как настоящий скриншот) */
    every: number;
    /** радиус «кругов» и «блуждания», м */
    radius: number;
    /** дошёл до конца маршрута — идти по нему заново */
    loop: boolean;
    /** самой снимать цели с маршрута, когда дошли до них (только сессия, прогресс игрока не трогаем) */
    eat: boolean;
    /** начать рейд (сессию навигации), если его ещё нет */
    inRaid: boolean;
}

export const DEFAULT_SIM: SimCfg = { mode: "route", speed: 6.5, every: 1, radius: 80, loop: true, eat: true, inRaid: true };

export const SIM_MODES: { id: SimMode; name: string }[] = [
    { id: "route", name: "по маршруту рейда" },
    { id: "reverse", name: "навстречу маршруту" },
    { id: "circle", name: "кругами на месте" },
    { id: "wander", name: "блуждание рядом" },
];

/** Считаем точку пройденной, когда дошли до неё (иначе игрок топчется на месте). */
const ARRIVE_M = 6;
/** След прогона на карте: держим последние точки, длинные прогоны не должны рисовать километры линий. */
const TRAIL_MAX = 600;

const near = (a: Vec3, b: Vec3, r: number) => Math.hypot(a.x - b.x, a.z - b.z) < r;
const ring = (c: Vec3, r: number, a: number): Vec3 => ({ x: c.x + Math.cos(a) * r, y: c.y, z: c.z + Math.sin(a) * r });

/** Точки маршрута: старт → цели → выход (повторяющиеся подряд точки убираем). */
export function routeTrack(raid: Raid | undefined): Vec3[] {
    const pts: Vec3[] = [];
    const push = (p: Vec3 | undefined) => {
        if (p && (!pts.length || !near(pts[pts.length - 1], p, 1))) pts.push(p);
    };
    push(raid?.spawn);
    for (const s of raid?.steps ?? []) push(s.point);
    push(raid?.extract?.position);
    return pts;
}

/**
 * Траектория режима. Для «по маршруту» и «навстречу» берём маршрут заново на каждом шаге:
 * приложение перестроило порядок целей — симулятор идёт к новой следующей точке, и как раз
 * видно, как маршрут переживает движение игрока. Для «кругов» траектория остаётся своей.
 */
export function simTrack(cfg: SimCfg, raid: Raid | undefined, origin: Vec3): Vec3[] {
    if (cfg.mode === "circle") return Array.from({ length: 13 }, (_, i) => ring(origin, cfg.radius, (i / 12) * Math.PI * 2));
    if (cfg.mode === "wander") return [];
    const t = routeTrack(raid);
    return cfg.mode === "reverse" ? t.slice().reverse() : t;
}

export interface SimState {
    mode: SimMode;
    /** вокруг этой точки кружим и блуждаем */
    origin: Vec3;
    pos: Vec3;
    /** куда идём (для «блуждания» — случайная точка рядом) */
    track: Vec3[];
    leg: number;
    /** направление взгляда — то же, что в имени файла скриншота */
    forward: { x: number; z: number };
    /** сколько прошёл, м */
    walked: number;
    aim?: Vec3;
    /** где уже побывали — на карте рисуем след прогона */
    trail: Vec3[];
    /** маршрут пройден (для «по маршруту» без повтора) */
    done: boolean;
}

/**
 * Симулятор ставит игрока в начало выбранного пути: «по маршруту» — на старт маршрута,
 * «навстречу» — на его конец (иначе первым же шагом пришлось бы бежать через всю карту).
 */
export function simStart(cfg: SimCfg, raid: Raid | undefined, from: Vec3): SimState {
    const track = simTrack(cfg, raid, from);
    const origin = cfg.mode === "route" || cfg.mode === "reverse" ? (track[0] ?? from) : from;
    let leg = 0;
    while (leg < track.length && near(origin, track[leg], ARRIVE_M)) leg++;
    // «круги» и «блуждание» не заканчиваются, маршрут пройти можно
    const ends = cfg.mode === "route" || cfg.mode === "reverse";
    return { mode: cfg.mode, origin, pos: origin, track, leg, forward: { x: 0, z: 1 }, walked: 0, trail: [origin], done: ends && track.length === 0 };
}

/** Пройти `dist` метров к точке `to` (вверх/вниз — пропорционально пути). */
function move(s: SimState, to: Vec3, dist: number): SimState {
    const dx = to.x - s.pos.x;
    const dz = to.z - s.pos.z;
    const d = Math.hypot(dx, dz);
    const k = Math.min(dist, d);
    if (d < 0.01 || k < 0.01) return { ...s, pos: { ...to }, walked: s.walked + k, trail: [...s.trail, { ...to }].slice(-TRAIL_MAX) };
    const fx = dx / d;
    const fz = dz / d;
    const pos: Vec3 = { x: s.pos.x + fx * k, y: s.pos.y + ((to.y - s.pos.y) * k) / d, z: s.pos.z + fz * k };
    return {
        ...s,
        pos,
        forward: { x: fx, z: fz },
        walked: s.walked + k,
        trail: [...s.trail, pos].slice(-TRAIL_MAX),
    };
}

/**
 * Шаг симулятора: `dist` метров к следующей точке пути. `raid` подаём текущий — траектория
 * «по маршруту» пересчитывается на каждом шаге, поэтому перестроение маршрута приложением
 * симулятор замечает сразу же.
 */
export function simStep(s: SimState, cfg: SimCfg, raid: Raid | undefined, dist: number): SimState {
    if (s.mode !== cfg.mode) return simStart(cfg, raid, s.origin);

    if (cfg.mode === "wander") {
        // новая случайная точка рядом: шажки меньше порога MOVE_M не должны перестраивать маршрут
        const aim = !s.aim || near(s.pos, s.aim, ARRIVE_M) ? ring(s.origin, cfg.radius * (0.25 + Math.random() * 0.75), Math.random() * Math.PI * 2) : s.aim;
        return { ...move(s, aim, dist), aim, done: false };
    }

    const track = cfg.mode === "circle" ? s.track : simTrack(cfg, raid, s.origin);
    let leg = s.leg;
    // точку прошли — или приложение перестроило маршрут, и она оказалась позади
    while (leg < track.length && near(s.pos, track[leg], ARRIVE_M)) leg++;
    if (leg >= track.length) {
        if (!cfg.loop) return { ...s, track, leg, done: true };
        leg = 0;
    }
    return { ...move({ ...s, track, leg }, track[leg], dist), track, leg, done: false };
}

/** Позиция симулятора в том же виде, что даёт разбор имени файла скриншота. */
export function simFix(s: SimState, mapKey: string): PlayerFix & { mapKey: string } {
    return {
        position: s.pos,
        heading: (Math.atan2(s.forward.x, s.forward.z) * 180) / Math.PI,
        forward: s.forward,
        time: Date.now(),
        file: "симулятор",
        mapKey,
    };
}

/** Отладочная строчка: сколько прошли и к какой точке пути идём. */
export function simText(s: SimState): string {
    const to = s.mode === "wander" ? "случайная точка" : s.track.length ? `точке ${Math.min(s.leg + 1, s.track.length)} из ${s.track.length}` : "нечего";
    return `пройдено ${Math.round(s.walked)} м · ${s.done ? "маршрут пройден" : `идём к ${to}`}`;
}
