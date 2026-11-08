// Вкладка «В рейде»: всё, что происходит в текущем рейде.
// Сверху — журнал изменений квестов за рейд (его можно откатывать построчно), ниже — plain-список
// квестов рейда: у каждого номера точек маршрута («1.2», как на карте и во «Вкладке Рейды»),
// подзадачи со статусами и сворачиваемый список всех мест цели, если их несколько.
import { useState } from "react";
import type { Bundle, Objective, Player, Task, Vec3 } from "../types";
import { fmtMin, type RaidStep } from "../lib/raids";
import { OBJECTIVE_LABEL, objectivePoints } from "../lib/quests";
import { canMarkEmpty, spotsText, type Session } from "./Hud";
import type { RaidActivity } from "../lib/raidHistory";

interface Props {
    /** Нет сессии — вкладка открыта из заблокированной кнопки: показываем подсказку. */
    session?: Session;
    bundle: Bundle;
    players: Player[];
    mapKey: string;
    mapName: string;
    /** Текущая цель маршрута (первая незакрытая точка). */
    target?: RaidStep;
    /** Журнал действий за рейд, от старых к новым. */
    activity: RaidActivity[];
    canUndo: boolean;
    canRedo: boolean;
    /** Что именно вернёт кнопка — в подсказке. */
    undoLabel: string;
    redoLabel: string;
    onUndo: () => void;
    onRedo: () => void;
    /** Вернуть (или снова применить) запись журнала; назад откатываются более поздние, вперёд — применяются более ранние отменённые. */
    onRevert: (id: number, forward?: boolean) => void;
    /** Отметить подзадачу выполненной (или снять отметку) у всех её владельцев. */
    onObjective: (task: Task, objectiveId: string, done: boolean, stopId?: string) => void;
    /** Действия над целью маршрута. */
    onDoneStop: (stopId: string) => void;
    onSkipStop: (stopId: string) => void;
    onEmptyStop: (stopId: string) => void;
    /** Навести карту на точку. */
    onFocus: (p: Vec3) => void;
    /** Свернуть навигатор. */
    onStop: () => void;
}

const samePos = (a: Vec3, b: Vec3) => a.x === b.x && a.y === b.y && a.z === b.z;

export default function InRaidTab({ session, bundle, players, mapKey, mapName, target, activity, canUndo, canRedo, undoLabel, redoLabel, onUndo, onRedo, onRevert, onObjective, onDoneStop, onSkipStop, onEmptyStop, onFocus, onStop }: Props) {
    /** Список мест цели раскрыт (id подзадачи). */
    const [openLoc, setOpenLoc] = useState<Set<string>>(new Set());
    const toggleLoc = (id: string) =>
        setOpenLoc((s) => {
            const n = new Set(s);
            if (n.has(id)) n.delete(id);
            else n.add(id);
            return n;
        });

    if (!session)
        return (
            <div className="tab">
                <div className="panel-title">
                    <span>В рейде · {mapName}</span>
                </div>
                <p className="empty">Рейд ещё не начат. Как только начнёшь — здесь появятся квесты этого рейда, их изменения и «Отменить».</p>
            </div>
        );

    const steps = session.raid.steps;
    /** Точка маршрута по id подзадачи (id цели = id точки маршрута). */
    const stepById = new Map(steps.map((s) => [s.stop.id, s]));
    /** Номера точек маршрута — те же, что на карте: в рейде маршрут один, поэтому «1.точка» (mapPlan в App перенумеровывает рейд сессии в 0). */
    const labelOf = (id: string) => {
        const i = steps.findIndex((s) => s.stop.id === id);
        return i < 0 ? undefined : `1.${i + 1}`;
    };
    const skipped = new Set(session.skipped);

    /** Владелец подзадачи: для цели из маршрута — её участники, иначе все, кто взял квест. */
    const ownersOf = (task: Task, stopId?: string) => {
        const st = stopId ? stepById.get(stopId) : undefined;
        if (st) return st.stop.players.map((pl) => players.find((x) => x.id === pl.id)).filter((x): x is Player => !!x);
        return players.filter((pl) => pl.tasks[task.id] === "active");
    };
    /** Выполнена ли подзадача: отметка есть у каждого владельца — как считает навигатор. */
    const isDone = (task: Task, o: Objective) => {
        const st = stepById.get(o.id);
        if (st)
            return st.stop.players.every((pl) => {
                const live = players.find((x) => x.id === pl.id);
                return !live || !!live.objectivesDone[o.id];
            });
        const own = players.filter((pl) => pl.tasks[task.id] === "active");
        return own.length > 0 && own.every((pl) => !!pl.objectivesDone[o.id]);
    };
    const dots = (list: Player[]) => list.map((pl) => <span key={pl.id} style={{ color: pl.color }}>● {pl.name}</span>);
    const time = (ts: number) => new Date(ts).toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit", second: "2-digit" });

    /** Все места подзадачи с переходом на карту; активное (то, куда ведём сейчас) помечено. */
    const locList = (o: Objective, st?: RaidStep) => {
        const pts = objectivePoints(o, mapKey);
        return (
            <div className="loc-list">
                {pts.map((pt, i) => {
                    const here = st ? samePos(pt.position, st.point) : i === 0;
                    return (
                        <button key={i} className={"loc" + (here ? " here" : "")} onClick={(e) => { e.stopPropagation(); onFocus(pt.position); }} title="Показать на карте">
                            <span className="num">{i + 1}</span>
                            <span className="loc-name">
                                {pt.kind === "zone" ? "зона" : "предмет"}
                                {pt.approx ? " · приблизительно" : ""}
                                {pt.top !== undefined ? ` · этаж ${pt.top}${pt.bottom !== undefined && pt.bottom !== pt.top ? `–${pt.bottom}` : ""}` : ""}
                            </span>
                            {here && st && <span className="loc-here">ведём сюда</span>}
                        </button>
                    );
                })}
            </div>
        );
    };

    /** Одна подзадача квеста: галочка, текст, номер точки, места, кто должен, «здесь нет», «пропустить». */
    const subRow = (task: Task, o: Objective, current: boolean) => {
        const st = stepById.get(o.id);
        const done = isDone(task, o);
        const sk = !!st && skipped.has(st.stop.id);
        const pts = objectivePoints(o, mapKey);
        const own = ownersOf(task, st ? st.stop.id : undefined);
        const need = own.filter((pl) => !pl.objectivesDone[o.id]);
        const label = labelOf(o.id);
        const focusPoint = st ? st.point : pts[0]?.position;
        const spots = st ? spotsText(session, st) : "";
        const otherMaps = [...new Set(o.maps)].map((k) => bundle.maps.find((m) => m.key === k)?.name ?? k).join(", ");
        return (
            <li key={o.id} className={`subtask${done ? " done" : ""}${sk ? " skipped" : ""}${current ? " cur" : ""}`}
                onClick={() => focusPoint && onFocus(focusPoint)} title={focusPoint ? "Показать на карте" : undefined}>
                <input type="checkbox" checked={done} disabled={!own.length}
                    onClick={(e) => e.stopPropagation()}
                    onChange={() => onObjective(task, o.id, !done, st?.stop.id)}
                    title={done ? "Снять отметку у всех владельцев" : own.length ? "Отметить выполненной у всех владельцев" : "Квест не взят ни одним игроком"} />
                <div className="sub-body">
                    <div className="desc">
                        {label && <span className="num" title={`Точка маршрута ${label}`}>{label}</span>}
                        <b>{OBJECTIVE_LABEL[o.type] ?? o.type}</b> {o.text}
                        {o.optional && <small className="muted"> · необязательно</small>}
                        {current && <span className="tag-cur">сейчас</span>}
                        {sk && <span className="warn"> пропущена</span>}
                    </div>
                    <div className="meta">
                        {st && <span>прибытие ~{fmtMin(st.eta)}</span>}
                        {st && spots && <span>{spots}</span>}
                        {!st && !!pts.length && <span>вне маршрута</span>}
                        {!pts.length && (!!o.zones?.length || !!o.locations?.length) && <span>не на этой карте{otherMaps ? `: ${otherMaps}` : ""}</span>}
                        {!!pts.length && pts.length > 1 && (
                            <button className="link" onClick={(e) => { e.stopPropagation(); toggleLoc(o.id); }} title="Список всех мест цели">
                                {openLoc.has(o.id) ? "▾" : "▸"} мест: {pts.length}
                            </button>
                        )}
                        {!!own.length && !done && <span className="who-line">{dots(need)}</span>}
                        {!own.length && <span className="muted">никто не брал</span>}
                    </div>
                    {openLoc.has(o.id) && locList(o, st)}
                    {st && !sk && (
                        <div className="sub-actions">
                            {canMarkEmpty(session, st) && (
                                <button className="link" onClick={(e) => { e.stopPropagation(); onEmptyStop(st.stop.id); }}
                                    title="Предмета здесь нет — убрать это место и перестроить маршрут">✗ здесь нет</button>
                            )}
                            <button className="link" onClick={(e) => { e.stopPropagation(); onSkipStop(st.stop.id); }} title="Пройти мимо и закрыть квест позже">пропустить</button>
                        </div>
                    )}
                </div>
            </li>
        );
    };

    /** Квесты рейда в порядке маршрута: квест → его точки в этом рейде. */
    const byTask: { task: Task; first: number; stopIds: string[] }[] = [];
    const idxOf = new Map<string, number>();
    steps.forEach((s, i) => {
        let at = idxOf.get(s.stop.task.id);
        if (at === undefined) {
            at = byTask.length;
            idxOf.set(s.stop.task.id, at);
            byTask.push({ task: s.stop.task, first: i, stopIds: [] });
        }
        byTask[at].stopIds.push(s.stop.id);
    });

    const doneCount = steps.filter((s) => isDone(s.stop.task, s.stop.objective)).length;
    const curTaskId = target?.stop.task.id;

    return (
        <div className="tab">
            <div className="panel-title">
                <span>В рейде · {mapName}</span>
                <small>{session.raid.name} · закрыто {doneCount} из {steps.length}{skipped.size ? ` · пропущено ${skipped.size}` : ""}</small>
                <button className="link" onClick={onStop}>закончить рейд</button>
            </div>

            <div className="panel-title">
                <span>Изменения в рейде</span>
                <small>{activity.length ? `${activity.length} · выполнено, пропущено, пустые места` : "пусто"}</small>
            </div>
            <div className="row raid-undo">
                <button disabled={!canUndo} onClick={onUndo} title={canUndo ? `Отменить: ${undoLabel}` : "Отменять нечего"}>↶ Отменить последнее</button>
                <button disabled={!canRedo} onClick={onRedo} title={canRedo ? `Вернуть: ${redoLabel}` : "Возвращать нечего"}>↷ Вернуть</button>
                <span className="hint">Ctrl+Z — отменить, Ctrl+Y — вернуть. У каждой записи ниже своя кнопка: «вернуть» откатывает и те действия, что были после неё, — вместе с маршрутом.</span>
            </div>
            {activity.length ? (
                <ol className="act-list">
                    {activity.map((a) => (
                        <li key={a.id} className={a.applied ? "" : "cancelled"}>
                            <span className="act-time">{time(a.ts)}</span>
                            <span className="act-label">{a.label}</span>
                            {a.applied ? (
                                <button className="link" onClick={() => onRevert(a.id)} title="Отменить это действие. Откатываются и те, что были после него: маршрут после действия перестраивался дальше.">↶ вернуть</button>
                            ) : (
                                <button className="link" onClick={() => onRevert(a.id, true)} title="Применить это действие снова. Применяются и отменённые действия раньше него — иначе маршрут окажется в рассогласованном состоянии.">↷ применить снова</button>
                            )}
                        </li>
                    ))}
                </ol>
            ) : (
                <p className="hint">За рейд ещё ничего не менялось. Здесь появятся отметки «выполнено», пропуски целей и пустые места — каждую можно будет вернуть.</p>
            )}

            <div className="panel-title">
                <span>Квесты этого рейда</span>
                <small>{byTask.length} · целей в маршруте {steps.length}</small>
            </div>
            {byTask.length ? byTask.map((g) => {
                const own = players.filter((pl) => pl.tasks[g.task.id] === "active");
                const closed = g.stopIds.every((id) => skipped.has(id) || isDone(g.task, stepById.get(id)!.stop.objective));
                const cur = g.task.id === curTaskId;
                return (
                    <article key={g.task.id} className={`raid${closed ? " closed" : ""}${cur ? " cur" : ""}`} style={{ "--rc": session.raid.color } as React.CSSProperties}>
                        <header onClick={() => onFocus(steps[g.first].point)} title="Показать на карте">
                            <span className="raid-no raid-no-label">{labelOf(g.stopIds[0]) ?? g.first + 1}</span>
                            <div className="raid-title">
                                <div className="name">{closed ? "✓ " : ""}{g.task.name}{cur && <span className="tag-cur">сейчас</span>}</div>
                                <div className="meta">
                                    ~{fmtMin(steps[g.first].eta)} · целей: {g.stopIds.length} · {bundle.traders[g.task.trader]?.name ?? g.task.trader}{own.length ? "" : " · никто не брал"}
                                </div>
                            </div>
                            <div className="raid-who">{dots(own)}</div>
                        </header>
                        <div className="raid-body">
                            {cur && target && (
                                <div className="sub-actions">
                                    <button className="primary" onClick={() => onDoneStop(target.stop.id)} title="Отметить подзадачу выполненной у всех владельцев">✓ Готово</button>
                                    {canMarkEmpty(session, target) && <button onClick={() => onEmptyStop(target.stop.id)} title="Предмета здесь нет — убрать это место и перестроить маршрут">✗ Здесь нет</button>}
                                    <button onClick={() => onSkipStop(target.stop.id)} title="Пройти мимо и закрыть квест позже">Пропустить</button>
                                </div>
                            )}
                            <ol className="subtasks">{g.task.objectives.map((o) => subRow(g.task, o, o.id === target?.stop.objective.id))}</ol>
                        </div>
                    </article>
                );
            }) : <p className="empty">В этом рейде нет квестов — маршрут пуст.</p>}

            <p className="hint">Галочка ставит отметку сразу у всех владельцев подзадачи. Номер «1.3» — точка маршрута, как на карте; у места с несколькими вариантами список мест раскрывается. Маршрут после пропуска или пустого места перестраивается, «вернуть» в журнале откатывает всё как было.</p>
        </div>
    );
}
