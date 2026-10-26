// Модель навигатора: всё, что показывает HUD, в виде простых данных.
// Её считает главное окно и отправляет в окно-виджет поверх игры (там только отрисовка).

import type { GameMap, MapDisplay, MapPoint, Vec3 } from "../types";
import type { RaidStep } from "./raids";
import { relativeBearing, type PlayerFix } from "./navigator";
import { OBJECTIVE_LABEL } from "./quests";
import { layerRu, type DetailRoute } from "./navdetail";
import { fmtMin, type Raid } from "./raids";

const LOOKAHEAD_M = 20;
const FLOOR_M = 3.2;

/** Точка на пути в LOOKAHEAD_M метрах от начала — туда и показывает стрелка. */
function lookahead(points: [number, number][]): { x: number; z: number } {
    let left = LOOKAHEAD_M;
    for (let i = 1; i < points.length; i++) {
        const [x0, z0] = points[i - 1];
        const [x1, z1] = points[i];
        const d = Math.hypot(x1 - x0, z1 - z0);
        if (d >= left) return { x: x0 + ((x1 - x0) * left) / d, z: z0 + ((z1 - z0) * left) / d };
        left -= d;
    }
    const [x, z] = points[points.length - 1];
    return { x, z };
}

/** Вектор (dx, dz) в игре → экранное направление «как на карте». */
export function mapScreenVec(display: MapDisplay, dx: number, dz: number): [number, number] {
    const a = (display.coordinateRotation * Math.PI) / 180;
    const lng = dx * Math.cos(a) - dz * Math.sin(a);
    const lat = dx * Math.sin(a) + dz * Math.cos(a);
    return [lng, -lat];
}

export interface HudPoint {
    x: number;
    y: number;
    z: number;
    label: string;
    target?: boolean;
    /** Другое возможное место той же цели (маршрут ведёт к ближайшему). */
    alt?: boolean;
}

export interface HudModel {
    raid: { name: string; color: string };
    map: { key: string; name: string; display: MapDisplay };
    /** Отсчёт таймера рейда (мс) и длительность рейда (с). */
    timerStart: number;
    raidSec: number;
    stepText: string;
    behindMin: number;
    goalName: string;
    objType?: string;
    objText?: string;
    players: { name: string; color: string }[];
    hasTarget: boolean;
    /** У цели несколько мест: можно отметить «здесь нет». left — сколько мест осталось, empty — сколько уже пустых. */
    spots?: { left: number; empty: number };
    fix?: { x: number; y: number; z: number; heading?: number; time: number };
    distance?: number;
    arrowDeg?: number;
    turnText: string;
    floorText: string;
    nextAction: string;
    pathMin?: number;
    arrived: boolean;
    guide?: [number, number][];
    points: HudPoint[];
    extract?: { x: number; z: number; name: string };
    screenshotKey: string;
}

export interface HudInput {
    map: GameMap;
    raid: Raid;
    timerStart: number;
    fix?: PlayerFix;
    target?: RaidStep;
    remaining: RaidStep[];
    extract?: MapPoint;
    guide?: { points: [number, number][]; length: number; detail?: DetailRoute };
    screenshotKey: string;
    now: number;
    /** Места, отмеченные «здесь нет» в этом рейде: id точки маршрута → число. */
    emptied?: Record<string, number>;
}

export function computeHud(inp: HudInput): HudModel {
    const { map, raid, fix, target, extract, guide } = inp;
    const goal: Vec3 | undefined = target?.point ?? extract?.position;
    const goalName = target ? target.stop.task.name : extract ? `Выход: ${extract.name}` : "Маршрут пройден";

    let distance: number | undefined;
    let arrowDeg: number | undefined;
    let turnText = "";
    let floorText = "";
    if (fix && goal) {
        // по реальному пути — к ближайшему повороту, иначе напрямик
        const aim = guide && guide.points.length > 1 ? { ...lookahead(guide.points), y: goal.y } : goal;
        distance = guide ? guide.length : Math.hypot(goal.x - fix.position.x, goal.z - fix.position.z);
        const rel = relativeBearing(fix, aim);
        if (rel !== undefined) {
            arrowDeg = rel;
            const a = Math.abs(Math.round(rel));
            turnText = a < 15 ? "прямо" : a > 160 ? "развернись" : `${rel > 0 ? "направо" : "налево"} ${a}°`;
        } else {
            const [sx, sy] = mapScreenVec(map.display, aim.x - fix.position.x, aim.z - fix.position.z);
            arrowDeg = (Math.atan2(sx, -sy) * 180) / Math.PI;
            turnText = "по карте";
        }
        const dy = goal.y - fix.position.y;
        if (Math.abs(dy) > FLOOR_M * 0.8) {
            const floors = Math.max(1, Math.round(Math.abs(dy) / FLOOR_M));
            floorText = `${dy > 0 ? "▲ выше" : "▼ ниже"} на ${floors} эт.`;
        }
    }

    // ближайшее действие по пути: вход, лестница
    let nextAction = "";
    if (guide?.detail && guide.points.length > 1) {
        const pts = guide.points;
        const cum = [0];
        for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]));
        const ev = guide.detail.events[0];
        if (ev) {
            let bi = 0;
            let bd = Infinity;
            pts.forEach(([px, pz], i) => {
                const dd = Math.hypot(px - ev.x, pz - ev.z);
                if (dd < bd) {
                    bd = dd;
                    bi = i;
                }
            });
            const d = Math.max(0, Math.round(cum[bi]));
            const what = ev.kind === "door-in" ? "вход в здание" : ev.kind === "door-out" ? "выход на улицу" : `${ev.kind === "up" ? "▲ наверх" : "▼ вниз"}: ${layerRu(ev.toLayerName ?? "")}`;
            nextAction = d < 3 ? what : `${what} · через ${d} м`;
        }
    }

    const straight = fix && goal ? Math.hypot(goal.x - fix.position.x, goal.z - fix.position.z) : undefined;
    const elapsed = (inp.now - inp.timerStart) / 1000;
    const idx = target ? raid.steps.indexOf(target) : -1;
    return {
        raid: { name: raid.name, color: raid.color },
        map: { key: map.key, name: map.name, display: map.display },
        timerStart: inp.timerStart,
        raidSec: (map.raidDuration ?? 40) * 60,
        stepText: target ? `Точка ${raid.index + 1}.${idx + 1} · ${idx + 1} из ${raid.steps.length}` : "Финиш — к выходу",
        behindMin: target && elapsed - target.eta > 60 ? Math.round((elapsed - target.eta) / 60) : 0,
        goalName,
        objType: target ? OBJECTIVE_LABEL[target.stop.objective.type] ?? "" : undefined,
        objText: target?.stop.objective.text,
        players: target ? target.stop.players.map((p) => ({ name: p.name, color: p.color })) : [],
        hasTarget: !!target,
        spots:
            target && (target.stop.points.length > 1 || inp.emptied?.[target.stop.id])
                ? { left: target.stop.points.length, empty: inp.emptied?.[target.stop.id] ?? 0 }
                : undefined,
        fix: fix ? { ...fix.position, heading: fix.heading, time: fix.time } : undefined,
        distance,
        arrowDeg,
        turnText,
        floorText,
        nextAction,
        pathMin: guide ? Math.max(1, Math.round((guide.length * 1.1) / 2.2 / 60)) : undefined,
        arrived: straight !== undefined && straight < 7 && !floorText,
        guide: guide?.points,
        points: inp.remaining.flatMap((s) => {
            const label = `${raid.index + 1}.${raid.steps.indexOf(s) + 1}`;
            const alts = s.stop.points.filter((p) => p.position !== s.point).map((p) => ({ ...p.position, label, alt: true }));
            return [...alts, { ...s.point, label, target: s === target }];
        }),
        extract: extract ? { x: extract.position.x, z: extract.position.z, name: extract.name } : undefined,
        screenshotKey: inp.screenshotKey,
    };
}

/** Предложение «Рейд начался» для виджета. */
export interface RaidOffer {
    mapName: string;
    startedAt: number;
    defaultRaid: number;
    raids: { index: number; name: string; steps: number; time: string; best: boolean; color: string }[];
    /** Подсказка: от чего построен маршрут и какие выходы учтены. */
    note?: string;
}

export function raidOffer(mapName: string, startedAt: number, raids: Raid[], defaultRaid: number, note?: string): RaidOffer {
    return {
        mapName,
        startedAt,
        defaultRaid,
        note,
        raids: raids.map((r) => ({ index: r.index, name: r.name, steps: r.steps.length, time: fmtMin(r.totalSec), best: !!r.best, color: r.color })),
    };
}

/** Что отправляется в окно-виджет. */
export type OverlayModel = { kind: "idle" } | { kind: "offer"; offer: RaidOffer } | { kind: "hud"; hud: HudModel };

export const fmtClock = (sec: number) => {
    const s = Math.max(0, Math.floor(sec));
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
};
