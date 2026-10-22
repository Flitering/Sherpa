import { useSticky } from "../lib/sticky";
import type { Bundle, GameMap, Player, Task } from "../types";
import type { RaidPlan, RaidSettings } from "../lib/raids";
import { DEFAULT_RAID_SETTINGS, fmtMin } from "../lib/raids";
import { OBJECTIVE_LABEL } from "../lib/quests";
import ItemIcon from "./ItemIcon";
import { describeRoute, type DetailRoute } from "../lib/navdetail";

interface Props {
    bundle: Bundle;
    map: GameMap;
    plan: RaidPlan;
    players: Player[];
    settings: RaidSettings;
    setSettings: (s: RaidSettings) => void;
    selected: number | null;
    setSelected: (i: number | null) => void;
    extractOverride: Record<number, string>;
    setExtractOverride: (o: Record<number, string>) => void;
    includeShoot: boolean;
    setIncludeShoot: (b: boolean) => void;
    sideTasks: { task: Task; text: string; players: Player[] }[];
    onStart: (raid: number) => void;
    onFocusStop: (stopId: string, raid: number) => void;
    sessionRaid?: string;
    routesState: "none" | "loading" | "computing" | "real" | "error" | "straight";
    routeMode: "real" | "straight";
    setRouteMode: (m: "real" | "straight") => void;
    /** Доступные в этом рейде выходы; undefined — все. */
    availableExtracts?: string[];
    /** Список выходов прочитан со скриншота в текущем рейде. */
    exitsFromShot?: boolean;
    setAvailableExtracts: (list: string[] | undefined) => void;
    detail?: { stopId: string; route: DetailRoute | null; loading: boolean };
}

const ROUTES_TEXT = {
    none: "пути по прямой (у этой карты нет схемы для расчёта)",
    loading: "строю сетку проходимости…",
    computing: "считаю пути по карте…",
    real: "пути по карте: в обход зданий, заборов и минных полей",
    error: "не удалось построить сетку — пути по прямой",
    straight: "пути по прямой (выбрано): линии идут сквозь стены и препятствия",
};

export default function RaidsTab(p: Props) {
    const [tune, setTune] = useSticky("raids.tune", false);
    const [exitsOpen, setExitsOpen] = useSticky("raids.exitsOpen", false);
    const exits = p.map.extracts.filter((e) => e.faction !== "scav");
    const avail = p.availableExtracts ? new Set(p.availableExtracts) : undefined;
    const isOn = (name: string) => !avail || avail.has(name);
    const toggleExit = (name: string) => {
        const cur = new Set(avail ?? exits.map((e) => e.name));
        if (cur.has(name)) cur.delete(name);
        else cur.add(name);
        p.setAvailableExtracts(cur.size === exits.length ? undefined : [...cur]);
    };
    const s = p.settings;
    const set = (patch: Partial<RaidSettings>) => p.setSettings({ ...s, ...patch });
    const total = p.plan.raids.reduce((a, r) => a + r.steps.length, 0);

    return (
        <div className="tab">
            <div className="panel-title">
                <span>План · {p.map.name}</span>
                <small>
                    {p.plan.raids.length} рейд(а) · {total} точек · рейд {fmtMin(p.plan.raidSec)}
                </small>
            </div>

            <div className="row">
                <div className="seg">
                    <button className={p.routeMode === "real" ? "on" : ""} onClick={() => p.setRouteMode("real")} title="Маршрут по улицам и проходам, в обход препятствий">
                        Пути по карте
                    </button>
                    <button className={p.routeMode === "straight" ? "on" : ""} onClick={() => p.setRouteMode("straight")} title="Прямые линии между точками, сквозь стены">
                        По прямой
                    </button>
                </div>
            </div>
            <div className={"routes-state " + p.routesState}>{ROUTES_TEXT[p.routesState]}</div>

            <div className="exits">
                <button className="exits-head" onClick={() => setExitsOpen(!exitsOpen)}>
                    <span>Выходы в этом рейде</span>
                    <small>
                        {avail ? `${exits.filter((e) => avail.has(e.name)).length} из ${exits.length}` : "все"}
                        {p.exitsFromShot && " · со скриншота"}
                    </small>
                </button>
                {exitsOpen && (
                    <>
                        <p className="hint">
                            В рейде дважды нажми O и сделай скриншот — Sherpa сама прочитает открытые тебе выходы. Или отметь их здесь вручную. Маршрут и выбор рейдов учтут
                            только их.
                        </p>
                        <div className="exit-chips">
                            {exits.map((e) => (
                                <button key={e.name} className={"chip" + (isOn(e.name) ? " on" : "")} onClick={() => toggleExit(e.name)} title={e.paid ? `Платный: ${p.bundle.items[e.paid.item]?.name ?? ""} ×${e.paid.count}` : undefined}>
                                    {e.name}
                                    {e.faction === "shared" && <small> · общий</small>}
                                    {e.paid && <small> · ₽</small>}
                                </button>
                            ))}
                        </div>
                        <div className="row">
                            <button onClick={() => p.setAvailableExtracts(undefined)}>Все</button>
                            <button onClick={() => p.setAvailableExtracts(exits.filter((e) => !e.paid).map((e) => e.name))}>Без платных</button>
                        </div>
                    </>
                )}
            </div>
            <div className="row">
                <button className={p.selected === null ? "on" : ""} onClick={() => p.setSelected(null)}>Все рейды</button>
                <button onClick={() => setTune(!tune)}>{tune ? "Скрыть настройки" : "⚙ Темп"}</button>
                <label className="check">
                    <input type="checkbox" checked={p.includeShoot} onChange={(e) => p.setIncludeShoot(e.target.checked)} /> зоны убийств
                </label>
            </div>

            {tune && (
                <div className="tune">
                    <label>
                        Скорость <b>{s.speed.toFixed(1)} м/с</b>
                        <input type="range" min={1.2} max={4} step={0.1} value={s.speed} onChange={(e) => set({ speed: +e.target.value })} />
                        <small>осторожно ≈1.8 · бодро ≈2.5 · спринт ≈4</small>
                    </label>
                    <label title="Используется, только если пути по карте недоступны">
                        Обходы зданий (без сетки) <b>×{s.detour.toFixed(2)}</b>
                        <input type="range" min={1} max={2} step={0.05} value={s.detour} onChange={(e) => set({ detour: +e.target.value })} />
                    </label>
                    <label>
                        Планировать <b>{Math.round(s.budgetShare * 100)}%</b> времени рейда
                        <input type="range" min={0.3} max={0.95} step={0.05} value={s.budgetShare} onChange={(e) => set({ budgetShare: +e.target.value })} />
                        <small>остальное — бой, лут, ожидание</small>
                    </label>
                    <button onClick={() => p.setSettings(DEFAULT_RAID_SETTINGS)}>По умолчанию</button>
                </div>
            )}

            {p.plan.raids.length === 0 && <p className="empty">На этой карте нет целей у активных квестов. Отметь квесты на вкладке «Квесты».</p>}

            {p.plan.raids.map((r) => {
                const open = p.selected === r.index;
                const over = r.totalSec > p.plan.budgetSec;
                const players = [...new Map(r.steps.flatMap((st) => st.stop.players).map((pl) => [pl.id, pl])).values()];
                const keys = [...new Set(r.steps.flatMap((st) => st.stop.objective.keys?.map((alt) => alt[0]) ?? []))];
                return (
                    <article key={r.index} className={"raid" + (open ? " open" : "")} style={{ "--rc": r.color } as React.CSSProperties}>
                        <header onClick={() => p.setSelected(open ? null : r.index)}>
                            <span className="raid-no">{r.index + 1}</span>
                            <div className="raid-title">
                                <div className="name">
                                    {r.name}
                                    {r.best && <span className="badge best" title="Больше всего целей в минуту при выбранных выходах">★ выгоднее всего</span>}
                                </div>
                                <div className="meta">
                                    {r.steps.length} точек{r.shared ? ` · общих ${r.shared}` : ""} ·{" "}
                                    <span className={over ? "warn" : ""}>~{fmtMin(r.totalSec)}</span>
                                    {r.lengthM !== undefined && ` · ${(r.lengthM / 1000).toFixed(1)} км`}
                                    {r.extract && ` · выход: ${r.extract.name}`}
                                </div>
                            </div>
                            <div className="raid-who">
                                {players.map((pl) => (
                                    <i key={pl.id} style={{ background: pl.color }} title={pl.name} />
                                ))}
                            </div>
                        </header>
                        <div className="raid-bar">
                            <div style={{ width: `${Math.min(100, (r.travelSec / p.plan.raidSec) * 100)}%` }} className="bar-travel" title="дорога" />
                            <div style={{ width: `${Math.min(100, (r.taskSec / p.plan.raidSec) * 100)}%` }} className="bar-task" title="задания" />
                        </div>
                        {open && (
                            <div className="raid-body">
                                <ol className="steps">
                                    {r.steps.map((st, i) => (
                                        <li key={st.stop.id} className={p.detail?.stopId === st.stop.id ? "selected" : ""} onClick={() => p.onFocusStop(st.stop.id, r.index)}>
                                            <span className="num">
                                                {r.index + 1}.{i + 1}
                                            </span>
                                            <div>
                                                <div className="name">
                                                    {st.stop.task.name} <small className="muted">· {fmtMin(st.eta)}</small>
                                                </div>
                                                <div className="desc">
                                                    <b>{OBJECTIVE_LABEL[st.stop.objective.type] ?? ""}</b> {st.stop.objective.text}
                                                </div>
                                                <div className="who-line">
                                                    {st.stop.players.map((pl) => (
                                                        <span key={pl.id} style={{ color: pl.color }}>● {pl.name} </span>
                                                    ))}
                                                    {st.stop.points.length > 1 && <span className="muted">· мест: {st.stop.points.length}</span>}
                                                </div>
                                                {p.detail?.stopId === st.stop.id && (
                                                    <div className="detail-steps">
                                                        {p.detail.loading
                                                            ? "строю путь через двери и лестницы…"
                                                            : p.detail.route
                                                              ? describeRoute(p.detail.route).map((t, k) => <span key={k}>{t}</span>)
                                                              : "подробный путь не найден — показан общий"}
                                                    </div>
                                                )}
                                            </div>
                                        </li>
                                    ))}
                                </ol>
                                {keys.length > 0 && (
                                    <div className="raid-keys">
                                        <span className="muted">Ключи:</span>
                                        {keys.map((k) => <ItemIcon key={k} bundle={p.bundle} id={k} size={30} />)}
                                    </div>
                                )}
                                <label className="field">
                                    Выход
                                    <select
                                        value={p.extractOverride[r.index] ?? ""}
                                        onChange={(e) => {
                                            const o = { ...p.extractOverride };
                                            if (e.target.value) o[r.index] = e.target.value;
                                            else delete o[r.index];
                                            p.setExtractOverride(o);
                                        }}
                                    >
                                        <option value="">ближайший{r.extract && !p.extractOverride[r.index] ? ` (${r.extract.name})` : ""}</option>
                                        {p.map.extracts.filter((e) => e.faction !== "scav").map((e) => (
                                            <option key={e.name} value={e.name}>{e.name}{e.faction === "shared" ? " (общий)" : ""}</option>
                                        ))}
                                        {p.map.transits.map((t) => (
                                            <option key={t.name} value={t.name}>{t.name}</option>
                                        ))}
                                    </select>
                                </label>
                                <button className="primary wide" onClick={() => p.onStart(r.index)}>
                                    {p.sessionRaid === r.name ? "▶ Навигатор запущен" : "▶ В рейд — запустить навигатор"}
                                </button>
                            </div>
                        )}
                    </article>
                );
            })}

            {p.sideTasks.length > 0 && (
                <section className="side-tasks">
                    <div className="panel-title"><span>Попутно в любом рейде</span></div>
                    {p.sideTasks.map((t, i) => (
                        <div key={i} className="side-task">
                            <b>{t.task.name}</b> — {t.text}{" "}
                            {t.players.map((pl) => <span key={pl.id} style={{ color: pl.color }}>●</span>)}
                        </div>
                    ))}
                </section>
            )}

            <p className="hint">
                Время — оценка: путь по прямой × коэффициент обходов, плюс время на каждую цель и дорогу до выхода. Рейды упорядочены: сначала с общими целями.
            </p>
        </div>
    );
}
