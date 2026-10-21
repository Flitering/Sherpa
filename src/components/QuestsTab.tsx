import { memo, useMemo } from "react";
import { useSticky } from "../lib/sticky";
import type { Bundle, Player, Task, TaskStatus, Vec3 } from "../types";
import { isAvailable, objectivePoints, OBJECTIVE_LABEL, taskOnMap } from "../lib/quests";
import ItemIcon from "./ItemIcon";

type Scope = "map" | "all";
type Filter = "active" | "available" | "all";

interface Props {
    /** Блок распознавания заданий со скриншота. */
    scan?: React.ReactNode;
    bundle: Bundle;
    players: Player[];
    mapKey: string;
    mapName: string;
    setTaskStatus: (playerId: string, taskId: string, s: TaskStatus | undefined) => void;
    toggleObjective: (playerId: string, objectiveId: string) => void;
    onFocus: (p: Vec3) => void;
}

const NEXT: Record<string, TaskStatus | undefined> = { none: "active", active: "done", done: undefined };
const STATUS_TITLE = { none: "не взят", active: "активен", done: "выполнен" };

const PAGE = 60;

export default memo(QuestsTab);

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
            <p className="hint">
                Кружок игрока: нажатие переключает «не взят → активен → выполнен». «Доступные» учитывают уровень и выполненные предыдущие квесты.
            </p>
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

function TaskCard({ task, bundle, players, mapKey, open, onToggle, setTaskStatus, toggleObjective, onFocus }: Props & { task: Task; open: boolean; onToggle: () => void }) {
    const trader = bundle.traders[task.trader];
    const mapName = task.map ? bundle.maps.find((m) => m.key === task.map)?.name : undefined;
    return (
        <article className={"card" + (open ? " open" : "")}>
            <div className="card-head" onClick={onToggle}>
                {trader?.image && <img className="trader" src={trader.image} alt="" referrerPolicy="no-referrer" />}
                <div className="card-title">
                    <div className="name">{task.name}</div>
                    <div className="meta">
                        {trader?.name} · ур. {task.minPlayerLevel}
                        {mapName && ` · ${mapName}`}
                        {task.kappa && <span className="badge">Каппа</span>}
                        {task.lightkeeper && <span className="badge lk">Смотритель</span>}
                    </div>
                </div>
                <div className="who" onClick={(e) => e.stopPropagation()}>
                    {players.map((p) => {
                        const s = (p.tasks[task.id] as TaskStatus | undefined) ?? "none";
                        const avail = s === "none" && isAvailable(task, p);
                        return (
                            <button
                                key={p.id}
                                className={`pdot ${s}${avail ? " avail" : ""}`}
                                style={{ "--c": p.color } as React.CSSProperties}
                                title={`${p.name}: ${STATUS_TITLE[s]}${avail ? " (доступен)" : ""}`}
                                onClick={() => setTaskStatus(p.id, task.id, NEXT[s])}
                            >
                                {s === "done" ? "✓" : s === "active" ? "▶" : p.name.slice(0, 1)}
                            </button>
                        );
                    })}
                </div>
            </div>
            {open && (
                <div className="card-body">
                    {task.image && <img className="task-image" src={task.image} alt="" loading="lazy" referrerPolicy="no-referrer" />}
                    <ul className="objectives">
                        {task.objectives.map((o) => {
                            const pts = objectivePoints(o, mapKey);
                            return (
                                <li key={o.id} className={o.optional ? "optional" : ""}>
                                    <div className="obj-line">
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
                                        {pts.length > 0 && (
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
