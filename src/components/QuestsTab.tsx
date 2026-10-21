import { memo, useMemo } from "react";
import { useSticky } from "../lib/sticky";
import type { Bundle, Player, Task, TaskStatus, Vec3 } from "../types";
import { isAvailable, objectivePoints, OBJECTIVE_LABEL, taskOnMap } from "../lib/quests";
import ItemIcon from "./ItemIcon";

type Scope = "map" | "all";
type Filter = "active" | "available" | "all";

/** Номер точки маршрута для цели: «2.3» — рейд 2, точка 3 (как на карте). */
export interface StopLabel {
    label: string;
    color: string;
}

interface Props {
    /** Блок распознавания заданий со скриншота. */
    scan?: React.ReactNode;
    bundle: Bundle;
    players: Player[];
    mapKey: string;
    mapName: string;
    /** objectiveId → номер точки маршрута на карте. */
    stopLabels: Map<string, StopLabel>;
    setTaskStatus: (playerId: string, taskId: string, s: TaskStatus | undefined) => void;
    toggleObjective: (playerId: string, objectiveId: string) => void;
    onFocus: (p: Vec3) => void;
    /** Показать точку маршрута этой цели на карте (выбрать рейд и построить подробный путь). */
    onPickStop: (objectiveId: string) => void;
}

const NEXT: Record<string, TaskStatus | undefined> = { none: "active", active: "done", done: undefined };
const STATUS_TITLE = { none: "не взят", active: "активен", done: "выполнен" };

const PAGE = 60;

export default memo(QuestsTab);

/** Условие открытия квеста вместо «ур. 0»: уровень, торговец, сюжет. */
export function unlockText(task: Task, bundle: Bundle): string {
    const parts: string[] = [];
    if (task.minPlayerLevel > 0) parts.push(`ур. ${task.minPlayerLevel}`);
    for (const r of task.traderReq ?? []) {
        const name = bundle.traders[r.trader]?.name ?? "торговец";
        parts.push(r.type === "level" ? `${name} L${r.value}` : `${name}: репутация ${r.value}`);
    }
    if (task.story) parts.push("по сюжету");
    if (!parts.length) parts.push(task.requires.length ? "после предыдущих" : "сразу");
    return parts.join(" · ");
}

function QuestsTab(props: Props) {
    const { bundle, players, mapKey } = props;
    const [scope, setScope] = useSticky<Scope>("quests.scope", "map");
    const [filter, setFilter] = useSticky<Filter>("quests.filter", "active");
    const [q, setQ] = useSticky("quests.q", "");
    const [open, setOpen] = useSticky<string | null>("quests.open", null);
    // длинный список рисуем частями — 500 карточек сразу заметно тормозят
    const [limit, setLimit] = useSticky("quests.limit", PAGE);

    const list = useMemo(() => {
        const query = q.trim().toLowerCase();
        return bundle.tasks
            .filter((t) => scope === "all" || taskOnMap(t, mapKey))
            .filter((t) => {
                if (filter === "all") return true;
                if (filter === "active") return players.some((p) => p.tasks[t.id] === "active");
                return players.some((p) => p.tasks[t.id] === "active" || isAvailable(t, p));
            })
            .filter((t) => !query || t.name.toLowerCase().includes(query) || bundle.traders[t.trader]?.name.toLowerCase().includes(query))
            .sort((a, b) => a.minPlayerLevel - b.minPlayerLevel || a.name.localeCompare(b.name));
    }, [bundle, players, scope, filter, q, mapKey]);

    return (
        <div className="tab">
            <div className="seg">
                <button className={scope === "map" ? "on" : ""} onClick={() => setScope("map")}>{props.mapName}</button>
                <button className={scope === "all" ? "on" : ""} onClick={() => setScope("all")}>Все карты</button>
            </div>
            <div className="seg">
                <button className={filter === "active" ? "on" : ""} onClick={() => setFilter("active")}>Активные</button>
                <button className={filter === "available" ? "on" : ""} onClick={() => setFilter("available")}>Доступные</button>
                <button className={filter === "all" ? "on" : ""} onClick={() => setFilter("all")}>Все</button>
            </div>
            {props.scan}
            <input className="search" placeholder="Поиск по названию или торговцу" value={q} onChange={(e) => setQ(e.target.value)} />
            <div className="legend">
                {players.map((p, i) => (
                    <span key={p.id} style={{ color: p.color }}>
                        <b>{i + 1}</b> — {p.name}
                    </span>
                ))}
                <span className="muted">· кнопка игрока: не взят → ▶ активен → ✓ выполнен</span>
            </div>
            {list.length === 0 && <p className="empty">{filter === "active" ? "Нет активных квестов. Переключись на «Доступные» и отметь взятые." : "Ничего не найдено."}</p>}
            {list.slice(0, limit).map((t) => (
                <TaskCard key={t.id} task={t} {...props} open={open === t.id} onToggle={() => setOpen(open === t.id ? null : t.id)} />
            ))}
            {list.length > limit && (
                <button className="wide" onClick={() => setLimit(limit + PAGE)}>
                    Показать ещё ({list.length - limit})
                </button>
            )}
        </div>
    );
}

function TaskCard({ task, bundle, players, mapKey, open, onToggle, setTaskStatus, toggleObjective, onFocus, stopLabels, onPickStop }: Props & { task: Task; open: boolean; onToggle: () => void }) {
    const trader = bundle.traders[task.trader];
    const mapName = task.map ? bundle.maps.find((m) => m.key === task.map)?.name : undefined;
    const labels = task.objectives.map((o) => stopLabels.get(o.id)).filter(Boolean) as StopLabel[];
    const prereq = task.requires
        .filter((r) => r.status.includes("complete"))
        .map((r) => bundle.tasks.find((t) => t.id === r.task)?.name)
        .filter(Boolean);
    return (
        <article className={"card" + (open ? " open" : "")}>
            <div className="card-head" onClick={onToggle}>
                {trader?.image && <img className="trader" src={trader.image} alt="" referrerPolicy="no-referrer" />}
                <div className="card-title">
                    <div className="name">{task.name}</div>
                    <div className="meta">
                        {trader?.name} · {unlockText(task, bundle)}
                        {mapName && ` · ${mapName}`}
                        {task.kappa && <span className="badge">Каппа</span>}
                        {task.lightkeeper && <span className="badge lk">Смотритель</span>}
                    </div>
                    {labels.length > 0 && (
                        <div className="stop-chips" title="Точки маршрута на карте">
                            {labels.map((l) => (
                                <span key={l.label} className="stop-chip" style={{ "--rc": l.color } as React.CSSProperties}>
                                    {l.label}
                                </span>
                            ))}
                        </div>
                    )}
                </div>
                <div className="who" onClick={(e) => e.stopPropagation()}>
                    {players.map((p, i) => {
                        const s = (p.tasks[task.id] as TaskStatus | undefined) ?? "none";
                        const avail = s === "none" && isAvailable(task, p);
                        return (
                            <button
                                key={p.id}
                                className={`pdot ${s}${avail ? " avail" : ""}`}
                                style={{ "--c": p.color } as React.CSSProperties}
                                title={`${p.name}: ${STATUS_TITLE[s]}${avail ? " (можно взять)" : ""} — нажми, чтобы сменить`}
                                onClick={() => setTaskStatus(p.id, task.id, NEXT[s])}
                            >
                                {s === "done" ? "✓" : s === "active" ? "▶" : i + 1}
                            </button>
                        );
                    })}
                </div>
            </div>
            {open && (
                <div className="card-body">
                    {task.image && <img className="task-image" src={task.image} alt="" loading="lazy" referrerPolicy="no-referrer" />}
                    {prereq.length > 0 && <div className="hint">Открывается после: {prereq.join(", ")}</div>}
                    <ul className="objectives">
                        {task.objectives.map((o) => {
                            const pts = objectivePoints(o, mapKey);
                            const lab = stopLabels.get(o.id);
                            return (
                                <li key={o.id} className={o.optional ? "optional" : ""}>
                                    <div className="obj-line">
                                        {lab && (
                                            <button className="stop-chip" style={{ "--rc": lab.color } as React.CSSProperties} title="Показать точку маршрута на карте" onClick={() => onPickStop(o.id)}>
                                                {lab.label}
                                            </button>
                                        )}
                                        <span className="obj-type">{OBJECTIVE_LABEL[o.type] ?? o.type}</span>
                                        <span className="obj-text">
                                            {o.text}
                                            {o.count && o.count > 1 ? ` ×${o.count}` : ""}
                                            {o.fir && <span className="badge fir">FIR</span>}
                                            {o.optional && <span className="badge">необяз.</span>}
                                        </span>
                                    </div>
                                    <div className="obj-extra">
                                        {(o.items?.slice(0, 6) ?? []).map((id) => <ItemIcon key={id} bundle={bundle} id={id} size={28} />)}
                                        {o.items && o.items.length > 6 && <span className="muted">+{o.items.length - 6}</span>}
                                        {o.markerItem && <ItemIcon bundle={bundle} id={o.markerItem} size={28} />}
                                        {o.questItem && <ItemIcon bundle={bundle} id={o.questItem} size={28} />}
                                        {o.keys?.map((alt) => alt.map((k) => <span key={k} className="key-chip">🔑 <ItemIcon bundle={bundle} id={k} size={24} /></span>))}
                                        {pts.length > 0 && !lab && (
                                            <button className="link" onClick={() => onFocus(pts[0].position)}>
                                                на карте{pts.length > 1 ? ` (${pts.length})` : ""}
                                            </button>
                                        )}
                                        {players
                                            .filter((p) => p.tasks[task.id] === "active")
                                            .map((p) => (
                                                <label key={p.id} className="obj-check" style={{ color: p.color }}>
                                                    <input type="checkbox" checked={!!p.objectivesDone[o.id]} onChange={() => toggleObjective(p.id, o.id)} />
                                                    {p.name}
                                                </label>
                                            ))}
                                    </div>
                                </li>
                            );
                        })}
                    </ul>
                    {task.wiki && (
                        <a href={task.wiki} target="_blank" rel="noreferrer" className="link">
                            Вики ↗
                        </a>
                    )}
                </div>
            )}
        </article>
    );
}
