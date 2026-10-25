// Логика квестов: доступность, цели на карте, что взять с собой.

import type { Bundle, Objective, Player, Task, Vec3 } from "../types";

export const OBJECTIVE_LABEL: Record<string, string> = {
    visit: "Посетить",
    mark: "Отметить",
    plantItem: "Заложить",
    plantQuestItem: "Заложить",
    findQuestItem: "Найти",
    giveQuestItem: "Передать",
    findItem: "Найти",
    giveItem: "Передать",
    shoot: "Убить",
    extract: "Выжить",
    useItem: "Использовать",
    experience: "Состояние",
    skill: "Навык",
    buildWeapon: "Собрать",
    traderLevel: "Торговец",
    traderStanding: "Репутация",
    taskStatus: "Квест",
    sellItem: "Продать",
    dialogue: "Диалог",
};

// ---------- выбор квестов для плана ----------

/**
 * Какие квесты учитываются на карте, в рейдах и путях: правило пресета плюс ручные исключения.
 * Хранится правилом, а не списком id — новые квесты после обновления данных попадают в выбор сами.
 */
export interface QuestPick {
    base: "all" | "story" | "none";
    /** Включены вручную поверх пресета. */
    on: string[];
    /** Выключены вручную. */
    off: string[];
}

export const PICK_ALL: QuestPick = { base: "all", on: [], off: [] };

export const isStoryTask = (t: Task) => !!t.chapter;

export function isPicked(t: Task, pick: QuestPick = PICK_ALL): boolean {
    if (pick.off.includes(t.id)) return false;
    if (pick.on.includes(t.id)) return true;
    return pick.base === "all" || (pick.base === "story" && isStoryTask(t));
}

export function togglePick(t: Task, pick: QuestPick = PICK_ALL): QuestPick {
    const on = pick.on.filter((id) => id !== t.id);
    const off = pick.off.filter((id) => id !== t.id);
    if (isPicked(t, pick)) off.push(t.id);
    else on.push(t.id);
    return { ...pick, on, off };
}

export function statusOf(p: Player, taskId: string) {
    return p.tasks[taskId];
}

/** Можно ли взять квест: выполнены предыдущие и хватает уровня. */
export function isAvailable(task: Task, p: Player): boolean {
    if (p.tasks[task.id]) return false;
    if (task.minPlayerLevel > p.level) return false;
    return task.requires.every((r) => {
        const s = p.tasks[r.task];
        if (r.status.includes("complete") && s === "done") return true;
        if (r.status.includes("active") && (s === "active" || s === "done")) return true;
        // Требование «провален» нельзя проверить без игры — не блокируем.
        return r.status.every((x) => x === "failed");
    });
}

/** Квест относится к карте: указана карта или у целей есть зоны на ней. */
export function taskOnMap(task: Task, mapKey: string): boolean {
    if (task.map === mapKey) return true;
    return task.objectives.some((o) => o.maps.includes(mapKey));
}

/** Точки цели на карте. Любая из них подходит (альтернативы). */
export function objectivePoints(o: Objective, mapKey: string): { position: Vec3; outline?: [number, number][]; top?: number; bottom?: number; kind: "zone" | "item"; approx?: boolean }[] {
    const out: ReturnType<typeof objectivePoints> = [];
    for (const z of o.zones ?? []) if (z.map === mapKey) out.push({ ...z, kind: "zone" });
    for (const l of o.locations ?? []) if (l.map === mapKey) for (const p of l.positions) out.push({ position: p, kind: "item", approx: l.approx });
    return out;
}

export interface Stop {
    /** id цели — одна и та же у всех игроков, поэтому общие цели сливаются. */
    id: string;
    task: Task;
    objective: Objective;
    players: Player[];
    points: ReturnType<typeof objectivePoints>;
}

/** Невыполненные цели активных квестов всех игроков, у которых есть точки на этой карте. */
export function activeStops(bundle: Bundle, players: Player[], mapKey: string, includeShoot: boolean): Stop[] {
    const byId = new Map<string, Stop>();
    for (const task of bundle.tasks) {
        const owners = players.filter((p) => p.tasks[task.id] === "active");
        if (!owners.length) continue;
        for (const o of task.objectives) {
            if (o.type === "shoot" && !includeShoot) continue;
            const points = objectivePoints(o, mapKey);
            if (!points.length) continue;
            const who = owners.filter((p) => !p.objectivesDone[o.id]);
            if (!who.length) continue;
            byId.set(o.id, { id: o.id, task, objective: o, players: who, points });
        }
    }
    return [...byId.values()];
}

// ---------- снаряжение ----------

export interface NeedEntry {
    itemId: string;
    /** Варианты: «или любой из» — для ключей с альтернативами и списков предметов. */
    alternatives?: string[];
    count: number;
    fir: boolean;
    /** Ключ выдают при взятии квеста — его не нужно искать, только не забыть взять. */
    given?: boolean;
    reasons: { task: Task; objective?: Objective; players: Player[] }[];
}

function add(map: Map<string, NeedEntry>, key: string, entry: Omit<NeedEntry, "reasons">, reason: NeedEntry["reasons"][number]) {
    const cur = map.get(key);
    if (cur) {
        cur.count += entry.count;
        cur.reasons.push(reason);
    } else {
        map.set(key, { ...entry, reasons: [reason] });
    }
}

export interface Loadout {
    keys: NeedEntry[];
    bring: NeedEntry[];
    findOnMap: NeedEntry[];
    handIn: NeedEntry[];
}

/**
 * Что нужно для активных квестов.
 * keys/bring/findOnMap — для выбранной карты; handIn — по всем картам (сдать торговцу).
 */
export function loadout(bundle: Bundle, players: Player[], mapKey: string): Loadout {
    const keys = new Map<string, NeedEntry>();
    const bring = new Map<string, NeedEntry>();
    const find = new Map<string, NeedEntry>();
    const hand = new Map<string, NeedEntry>();

    for (const task of bundle.tasks) {
        const owners = players.filter((p) => p.tasks[task.id] === "active");
        if (!owners.length) continue;

        for (const o of task.objectives) {
            const who = owners.filter((p) => !p.objectivesDone[o.id]);
            if (!who.length) continue;
            const reason = { task, objective: o, players: who };
            const here = o.maps.includes(mapKey) || objectivePoints(o, mapKey).length > 0;
            const perPlayer = who.length;

            if (here) {
                for (const alt of o.keys ?? []) {
                    add(keys, alt.join("|"), { itemId: alt[0], alternatives: alt.length > 1 ? alt : undefined, count: 1, fir: false }, reason);
                }
                if (o.type === "mark" && o.markerItem) {
                    add(bring, o.markerItem, { itemId: o.markerItem, count: (o.count ?? 1) * perPlayer, fir: false }, reason);
                }
                if (o.type === "plantItem" && o.items?.length) {
                    add(bring, o.items.join("|"), { itemId: o.items[0], alternatives: o.items.length > 1 ? o.items : undefined, count: (o.count ?? 1) * perPlayer, fir: !!o.fir }, reason);
                }
                if (o.type === "plantQuestItem" && o.questItem) {
                    add(bring, o.questItem, { itemId: o.questItem, count: (o.count ?? 1) * perPlayer, fir: false }, reason);
                }
                if (o.type === "useItem" && o.items?.length) {
                    add(bring, o.items.join("|"), { itemId: o.items[0], alternatives: o.items.length > 1 ? o.items : undefined, count: (o.count ?? 1) * perPlayer, fir: false }, reason);
                }
                if (o.type === "findQuestItem" && o.questItem) {
                    add(find, o.questItem, { itemId: o.questItem, count: (o.count ?? 1) * perPlayer, fir: true }, reason);
                }
            }
            if ((o.type === "giveItem" || o.type === "findItem") && o.items?.length) {
                // findItem и giveItem обычно идут парой на один предмет — считаем только сдачу.
                if (o.type === "findItem" && task.objectives.some((x) => x.type === "giveItem" && x.items?.[0] === o.items![0])) continue;
                add(hand, o.items.join("|") + (o.fir ? "|fir" : ""), { itemId: o.items[0], alternatives: o.items.length > 1 ? o.items : undefined, count: (o.count ?? 1) * perPlayer, fir: !!o.fir }, reason);
            }
        }
        for (const nk of task.neededKeys) {
            if (nk.map !== mapKey) continue;
            const k = nk.keys.join("|");
            if (!keys.has(k)) add(keys, k, { itemId: nk.keys[0], alternatives: nk.keys.length > 1 ? nk.keys : undefined, count: 1, fir: false, given: nk.given }, { task, players: owners });
        }
    }
    const sort = (m: Map<string, NeedEntry>) => [...m.values()].sort((a, b) => (bundle.items[a.itemId]?.name ?? "").localeCompare(bundle.items[b.itemId]?.name ?? ""));
    // Ключ одноразово не тратится: одного хватает на все квесты.
    return { keys: sort(keys).map((k) => ({ ...k, count: 1 })), bring: sort(bring), findOnMap: sort(find), handIn: sort(hand) };
}
