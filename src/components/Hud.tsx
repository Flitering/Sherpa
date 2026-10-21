import type { GameMap, MapPoint, Vec3 } from "../types";
import type { Raid, RaidStep } from "../lib/raids";
import { relativeBearing, type PlayerFix } from "../lib/navigator";
import { OBJECTIVE_LABEL } from "../lib/quests";
import { layerRu, type DetailRoute } from "../lib/navdetail";

export interface Session {
    raid: Raid;
    startedAt: number;
    skipped: string[];
}

interface Props {
    map: GameMap;
    session: Session;
    fix?: PlayerFix;
    now: number;
    target?: RaidStep;
    remaining: RaidStep[];
    extract?: MapPoint;
    onDone: () => void;
    onSkip: () => void;
    onStop?: () => void;
    raidStartFromLog?: number;
    /** Путь от игрока до цели по сетке проходимости. */
    guide?: { points: [number, number][]; length: number; detail?: DetailRoute };
}

const LOOKAHEAD_M = 20;

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

const FLOOR_M = 3.2;

const fmt = (sec: number) => {
    const s = Math.max(0, Math.floor(sec));
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
};

/** Вектор (dx, dz) в игре → экранное направление: при известном взгляде — «вперёд вверх», иначе как на карте. */
function screenVec(map: GameMap, fix: PlayerFix | undefined, dx: number, dz: number): [number, number] {
    if (fix?.heading !== undefined) {
        const rel = Math.atan2(dx, dz) - (fix.heading * Math.PI) / 180;
        const r = Math.hypot(dx, dz);
        return [r * Math.sin(rel), -r * Math.cos(rel)];
    }
    const a = (map.display.coordinateRotation * Math.PI) / 180;
    const lng = dx * Math.cos(a) - dz * Math.sin(a);
    const lat = dx * Math.sin(a) + dz * Math.cos(a);
    return [lng, -lat];
}

export default function Hud({ map, session, fix, now, target, remaining, extract, onDone, onSkip, onStop, raidStartFromLog, guide }: Props) {
    const start = raidStartFromLog && raidStartFromLog > session.startedAt - 10 * 60_000 ? raidStartFromLog : session.startedAt;
    const elapsed = (now - start) / 1000;
    const raidSec = (map.raidDuration ?? 40) * 60;
    const goal: Vec3 | undefined = target?.point ?? extract?.position;
    const goalName = target ? target.stop.task.name : extract ? `Выход: ${extract.name}` : "Маршрут пройден";

    let distance: number | undefined;
    let arrowDeg: number | undefined;
    let turnText = "";
    let floorText = "";
    if (fix && goal) {
        // по реальному пути — к ближайшему повороту, иначе напрямик
        const aim = guide && guide.points.length > 1 ? { ...lookahead(guide.points), y: goal.y } : goal;
        const dx = aim.x - fix.position.x;
        const dz = aim.z - fix.position.z;
        distance = guide ? guide.length : Math.hypot(goal.x - fix.position.x, goal.z - fix.position.z);
        const rel = relativeBearing(fix, aim);
        if (rel !== undefined) {
            arrowDeg = rel;
            const a = Math.abs(Math.round(rel));
            turnText = a < 15 ? "прямо" : a > 160 ? "развернись" : `${rel > 0 ? "направо" : "налево"} ${a}°`;
        } else {
            const [sx, sy] = screenVec(map, undefined, dx, dz);
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
        const along = (x: number, z: number) => {
            let bi = 0;
            let bd = Infinity;
            pts.forEach(([px, pz], i) => {
                const dd = Math.hypot(px - x, pz - z);
                if (dd < bd) {
                    bd = dd;
                    bi = i;
                }
            });
            return cum[bi];
        };
        const ev = guide.detail.events[0];
        if (ev) {
            const d = Math.max(0, Math.round(along(ev.x, ev.z)));
            const what = ev.kind === "door-in" ? "вход в здание" : ev.kind === "door-out" ? "выход на улицу" : `${ev.kind === "up" ? "▲ наверх" : "▼ вниз"}: ${layerRu(ev.toLayerName ?? "")}`;
            nextAction = d < 3 ? what : `${what} · через ${d} м`;
        }
    }
    const straightDist = fix && goal ? Math.hypot(goal.x - fix.position.x, goal.z - fix.position.z) : undefined;
    const arrived = straightDist !== undefined && straightDist < 7 && !floorText;
    const age = fix ? Math.round((now - fix.time) / 1000) : undefined;
    const behind = target ? elapsed - target.eta : 0;

    return (
        <div className="hud">
            <div className="hud-top" style={{ borderColor: session.raid.color }}>
                <span className="hud-raid" style={{ color: session.raid.color }}>
                    {session.raid.name}
                </span>
                <span className={"hud-timer" + (elapsed > raidSec * 0.85 ? " late" : "")}>
                    {fmt(elapsed)} <small>/ {fmt(raidSec)}</small>
                </span>
            </div>

            <div className="hud-main">
                <div className={"hud-arrow" + (arrived ? " arrived" : "")}>
                    {arrived ? (
                        <span className="hud-here">НА МЕСТЕ</span>
                    ) : arrowDeg !== undefined ? (
                        <svg viewBox="-50 -50 100 100" style={{ transform: `rotate(${arrowDeg}deg)` }}>
                            <path d="M0 -42 L26 18 L0 6 L-26 18 Z" />
                        </svg>
                    ) : (
                        <span className="hud-noscr">
                            нажми
                            <br />
                            <b>Print Screen</b>
                        </span>
                    )}
                </div>
                <div className="hud-dist">
                    {distance !== undefined ? (
                        <>
                            <b>{Math.round(distance)}</b> м
                        </>
                    ) : (
                        "—"
                    )}
                    <div className="hud-turn">{turnText}</div>
                    {guide && <div className="hud-path">по пути · ~{Math.max(1, Math.round((guide.length * 1.1) / 2.2 / 60))} мин</div>}
                    {floorText && <div className="hud-floor">{floorText}</div>}
                    {nextAction && <div className="hud-next">{nextAction}</div>}
                </div>
            </div>

            <div className="hud-target">
                <div className="hud-step">
                    {target ? `Точка ${session.raid.steps.indexOf(target) + 1} из ${session.raid.steps.length}` : "Финиш"}
                    {target && behind > 60 && <span className="late"> · отстаём на {Math.round(behind / 60)} мин</span>}
                </div>
                <div className="hud-name">{goalName}</div>
                {target && (
                    <div className="hud-obj">
                        <b>{OBJECTIVE_LABEL[target.stop.objective.type] ?? ""}</b> {target.stop.objective.text}
                    </div>
                )}
                {target && (
                    <div className="hud-who">
                        {target.stop.players.map((p) => (
                            <span key={p.id} style={{ color: p.color }}>
                                ● {p.name}{" "}
                            </span>
                        ))}
                    </div>
                )}
            </div>

            <Radar map={map} fix={fix} steps={remaining} target={target} extract={extract} color={session.raid.color} />

            <div className="hud-actions">
                {target && (
                    <button className="primary" onClick={onDone}>
                        ✓ Выполнено
                    </button>
                )}
                {target && <button onClick={onSkip}>Пропустить</button>}
                {onStop && <button onClick={onStop}>Закончить</button>}
            </div>
            <div className="hud-foot">
                {age === undefined ? "Позиции ещё нет: сделай скриншот в игре" : `позиция ${age} с назад`}
            </div>
        </div>
    );
}

const RADAR_RANGE = 150; // м до края

function Radar({ map, fix, steps, target, extract, color }: { map: GameMap; fix?: PlayerFix; steps: RaidStep[]; target?: RaidStep; extract?: MapPoint; color: string }) {
    if (!fix) return null;
    const R = 70;
    const k = R / RADAR_RANGE;
    const place = (p: Vec3) => {
        let [x, y] = screenVec(map, fix, p.x - fix.position.x, p.z - fix.position.z);
        x *= k;
        y *= k;
        const r = Math.hypot(x, y);
        const clamped = r > R - 4;
        if (clamped) {
            x *= (R - 4) / r;
            y *= (R - 4) / r;
        }
        return { x, y, clamped };
    };
    return (
        <svg className="radar" viewBox={`${-R - 2} ${-R - 2} ${2 * R + 4} ${2 * R + 4}`}>
            <circle r={R} className="radar-bg" />
            <circle r={R / 2} className="radar-ring" />
            <line x1={-R} x2={R} className="radar-ring" />
            <line y1={-R} y2={R} className="radar-ring" />
            {extract && (() => {
                const p = place(extract.position);
                return <text x={p.x} y={p.y} className="radar-exit">EXIT</text>;
            })()}
            {steps.map((s) => {
                const p = place(s.point);
                const isT = s === target;
                return <circle key={s.stop.id} cx={p.x} cy={p.y} r={isT ? 5 : 3} fill={isT ? color : "none"} stroke={color} strokeWidth={1.5} opacity={p.clamped && !isT ? 0.5 : 1} />;
            })}
            <path d="M0 -7 L5 5 L0 2 L-5 5 Z" className="radar-me" />
            <text y={R - 6} className="radar-scale">{RADAR_RANGE} м</text>
        </svg>
    );
}
