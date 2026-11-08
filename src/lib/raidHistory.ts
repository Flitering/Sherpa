// История действий внутри рейда: кнопки «Отменить» и «Вернуть» возвращают статусы цели
// («выполнено», «пропущено», «место отмечено пустым») и изменённый ими маршрут обратно.
//
// Снимок берём только из того, что портят эти действия: маршрут рейда, пропущенные цели, пустые места
// и отметки квестов у игроков. Откатываем при этом именно те отметки, которые поменяло само действие
// (по ним ищем разницу между снимками): всё, что успела поставить синхронизация логов или игрок в
// «Группе» между делом, остаётся на месте. Снимок всего состояния приложения был бы расточителен и
// затирал бы эти чужие изменения.
//
// В историю попадают только действия игрока: перестроение маршрута под позицию и шаги симулятора
// историю не открывают — для них отмены нет.

import { useCallback, useRef, useState } from "react";
import type { Player } from "../types";
import type { Raid } from "./raids";

/** То, что может поменять действие над целью рейда. */
export interface RaidSnap {
    /** Маршрут рейда из сессии навигатора. */
    raid?: Raid;
    /** Цели, пропущенные в этом рейде (id точек маршрута). */
    skipped: string[];
    /** Сколько мест цели отмечено «здесь нет» (id точки маршрута → число). */
    emptied?: Record<string, number>;
    /** Игроки: смотрим только на их отметки целей (objectivesDone), остальное действия не касаются. */
    players: Player[];
}

/** Отметка одной цели у одного игрока: чем была и чем стала. */
interface ObjPatch {
    player: string;
    objective: string;
    from?: true;
    to?: true;
}

/** Что вернуть (или применить снова). Поля сессии отсутствуют — значит действие их не трогало. */
export interface RaidPatch {
    session?: { raid?: Raid; skipped: string[]; emptied?: Record<string, number> };
    objectives: ObjPatch[];
}

/** Один шаг истории: подпись (за что кнопка) и обратимый переход. */
interface RaidUndoStep {
    id: number;
    label: string;
    /** когда случилось действие — показать в журнале */
    ts: number;
    /** откат к «до» */
    back: RaidPatch;
    /** повтор к «после» */
    forward: RaidPatch;
}

/** Строка журнала изменений: чем подписать шаг и можно ли его вернуть/повторить. */
export interface RaidActivity {
    id: number;
    label: string;
    ts: number;
    /** действие применено (можно откатить) */
    applied: boolean;
}

/** Одинаковые ссылки — значит ничего не изменилось: обновление вернуло то же состояние. */
const sameSnap = (a: RaidSnap, b: RaidSnap) => a.raid === b.raid && a.skipped === b.skipped && a.emptied === b.emptied && a.players === b.players;

/** Разница только в отметках целей: те, что поменялись между двумя снимками игроков. */
function diffPlayers(before: Player[], after: Player[]): ObjPatch[] {
    const old = new Map(before.map((p) => [p.id, p]));
    const ops: ObjPatch[] = [];
    for (const p of after) {
        const prev = old.get(p.id);
        if (!prev) continue; // игрок появился позже — откатывать его отметки не за чем
        const a = prev.objectivesDone ?? {};
        const b = p.objectivesDone ?? {};
        for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) {
            if (a[key] !== b[key]) ops.push({ player: p.id, objective: key, from: a[key], to: b[key] });
        }
    }
    return ops;
}

/** Применить отметки к списку игроков: меняем только перечисленные цели, остальные поля как были. */
export function patchPlayers(players: Player[], ops: RaidPatch["objectives"]): Player[] {
    if (!ops.length) return players;
    const byPlayer = new Map<string, ObjPatch[]>();
    for (const o of ops) {
        const list = byPlayer.get(o.player);
        if (list) list.push(o);
        else byPlayer.set(o.player, [o]);
    }
    return players.map((p) => {
        const list = byPlayer.get(p.id);
        if (!list) return p;
        const done = { ...p.objectivesDone };
        for (const o of list) {
            if (o.to) done[o.objective] = o.to;
            else delete done[o.objective];
        }
        return { ...p, objectivesDone: done };
    });
}

/** Переход между двумя снимками: маршрут/пропуски/пустые места целиком, отметки — поштучно. */
function patches(a: RaidSnap, b: RaidSnap): { back: RaidPatch; forward: RaidPatch } | null {
    const ops = diffPlayers(a.players, b.players);
    const touched = a.raid !== b.raid || a.skipped !== b.skipped || a.emptied !== b.emptied || ops.length > 0;
    if (!touched) return null;
    const session = { raid: b.raid, skipped: b.skipped, emptied: b.emptied };
    return {
        forward: { session, objectives: ops },
        back: { session: { raid: a.raid, skipped: a.skipped, emptied: a.emptied }, objectives: ops.map((o) => ({ player: o.player, objective: o.objective, from: o.to, to: o.from })) },
    };
}

export function useRaidHistory() {
    const [hist, setHist] = useState<{ past: RaidUndoStep[]; future: RaidUndoStep[] }>({ past: [], future: [] });
    /** Действие, чьё изменение состояния мы ждём: подпись + снимок «до». */
    const pending = useRef<{ label: string; before: RaidSnap } | null>(null);
    /** Сквозной номер шага: остаётся при откате/повторе, по нему и откатываем конкретную запись журнала. */
    const seq = useRef(0);

    /** Перед тем как применить действие игрока. */
    const open = useCallback((label: string, before: RaidSnap) => {
        pending.current = { label, before };
    }, []);

    /** Вызывается после каждого изменения состояния рейда: записывает шаг, если его ждали. */
    const commit = useCallback((after: RaidSnap) => {
        const p = pending.current;
        pending.current = null;
        if (!p || sameSnap(p.before, after)) return;
        const step = patches(p.before, after);
        if (!step) return;
        setHist((s) => ({ past: [...s.past, { id: ++seq.current, label: p.label, ts: Date.now(), ...step }], future: [] }));
    }, []);

    /** Новая сессия рейда (или выход из него) — старая история больше не к месту. */
    const clear = useCallback(() => {
        pending.current = null;
        setHist({ past: [], future: [] });
    }, []);

    /** Шаг назад: чем вернуться (null — отменять нечего). */
    const undo = useCallback((): RaidPatch | null => {
        const step = hist.past[hist.past.length - 1];
        if (!step) return null;
        setHist({ past: hist.past.slice(0, -1), future: [step, ...hist.future] });
        return step.back;
    }, [hist]);

    /** Шаг вперёд после отмены: то же действие снова. */
    const redo = useCallback((): RaidPatch | null => {
        const step = hist.future[0];
        if (!step) return null;
        setHist({ past: [...hist.past, step], future: hist.future.slice(1) });
        return step.forward;
    }, [hist]);

    /**
     * Вернуть (или снова применить) запись журнала по её номеру. Патч действия хранит состояние всего
     * маршрута «до» и «после», поэтому одной записью обойтись нельзя: вместе с ней откатываются те,
     * что были ПОСЛЕ неё (или применяются те, что были РАНЬШЕ) — иначе состояние рассогласуется.
     * null — такой записи нет.
     */
    const revert = useCallback(
        (id: number, forward = false): RaidPatch[] | null => {
            if (forward) {
                const at = hist.future.findIndex((s) => s.id === id);
                if (at < 0) return null;
                const chain = hist.future.slice(at).reverse(); // от самой ранней отменённой к выбранной
                setHist({ past: [...hist.past, ...chain], future: hist.future.slice(0, at) });
                return chain.map((s) => s.forward);
            }
            const at = hist.past.findIndex((s) => s.id === id);
            if (at < 0) return null;
            const chain = hist.past.slice(at).reverse(); // от самой поздней к выбранной
            setHist({ past: hist.past.slice(0, at), future: [...chain, ...hist.future] });
            return chain.map((s) => s.back);
        },
        [hist],
    );

    /** Журнал изменений рейда: от старых к новым. Отменённые записи помечены applied: false. */
    const entries = useCallback(
        (): RaidActivity[] => [
            ...hist.past.map((s) => ({ id: s.id, label: s.label, ts: s.ts, applied: true })),
            ...hist.future.map((s) => ({ id: s.id, label: s.label, ts: s.ts, applied: false })).reverse(),
        ],
        [hist],
    );

    return {
        canUndo: hist.past.length > 0,
        canRedo: hist.future.length > 0,
        /** Что именно кнопка вернёт/повторит — для подсказки. */
        undoLabel: hist.past[hist.past.length - 1]?.label ?? "",
        redoLabel: hist.future[0]?.label ?? "",
        open,
        commit,
        clear,
        undo,
        redo,
        revert,
        entries,
    };
}
