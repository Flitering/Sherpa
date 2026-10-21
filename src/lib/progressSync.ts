// Применение прогресса квестов: события из логов, распознанный список заданий,
// и вывод выполненных квестов по цепочкам требований.

import type { Bundle, Player } from "../types";
import type { TaskEvent } from "./gamelogs";

export interface SyncSummary {
    started: number;
    finished: number;
    failed: number;
    inferred: number;
}

/**
 * Квесты, без выполнения которых не открылись бы активные/выполненные, — тоже выполнены.
 * Возвращает новое множество статусов и сколько квестов добавлено.
 */
export function inferCompleted(bundle: Bundle, tasks: Player["tasks"]): { tasks: Player["tasks"]; added: number } {
    const byId = new Map(bundle.tasks.map((t) => [t.id, t]));
    const out = { ...tasks };
    let added = 0;
    const stack = Object.keys(out).filter((id) => out[id]);
    const seen = new Set<string>();
    while (stack.length) {
        const id = stack.pop()!;
        if (seen.has(id)) continue;
        seen.add(id);
        for (const r of byId.get(id)?.requires ?? []) {
            if (!r.status.includes("complete")) continue;
            if (out[r.task] !== "done") {
                out[r.task] = "done";
                added++;
            }
            stack.push(r.task);
        }
    }
    return { tasks: out, added };
}

/** События логов → статусы игрока (только для текущего режима, только новее since). */
export function applyTaskEvents(bundle: Bundle, player: Player, events: TaskEvent[], mode: string, since: number): { player: Player; summary: SyncSummary; last: number } {
    const known = new Set(bundle.tasks.map((t) => t.id));
    const tasks = { ...player.tasks };
    const summary: SyncSummary = { started: 0, finished: 0, failed: 0, inferred: 0 };
    let last = since;
    for (const e of [...events].sort((a, b) => a.time - b.time)) {
        if (e.time <= since || !known.has(e.taskId)) continue;
        if (e.mode && e.mode !== mode) continue;
        last = Math.max(last, e.time);
        if (e.status === "started") {
            if (tasks[e.taskId] !== "done") {
                tasks[e.taskId] = "active";
                summary.started++;
            }
        } else if (e.status === "finished") {
            tasks[e.taskId] = "done";
            summary.finished++;
        } else {
            delete tasks[e.taskId];
            summary.failed++;
        }
    }
    const inf = inferCompleted(bundle, tasks);
    summary.inferred = inf.added;
    return { player: { ...player, tasks: inf.tasks }, summary, last };
}

/** Распознанные активные квесты → статусы игрока (+ вывод выполненных). */
export function applyActiveList(bundle: Bundle, player: Player, activeIds: string[]): { player: Player; added: number; inferred: number } {
    const tasks = { ...player.tasks };
    let added = 0;
    for (const id of activeIds) {
        if (tasks[id] !== "active") {
            tasks[id] = "active";
            added++;
        }
    }
    const inf = inferCompleted(bundle, tasks);
    return { player: { ...player, tasks: inf.tasks }, added, inferred: inf.added };
}
