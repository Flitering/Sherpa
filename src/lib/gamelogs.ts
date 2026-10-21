// Логи игры: текущая карта, начало рейда, режим (PvP/PvE) и события квестов.
//
// Папка «…\Escape from Tarkov\Logs» содержит папки сессий log_<дата>. В каждой:
//  - application*.log — «TRACE-NetworkGameCreate … Location: TarkovStreets», «Session mode: pve»;
//  - notifications*.log — «Got notification | ChatMessageReceived» и JSON с message.type:
//    10 — квест взят, 11 — провален, 12 — выполнен; message.templateId начинается с id квеста.
// Тот же принцип использует TarkovMonitor. Файлы только читаются.

export type TaskEventStatus = "started" | "failed" | "finished";

export interface TaskEvent {
    taskId: string;
    status: TaskEventStatus;
    /** Время события по логу (мс). */
    time: number;
    /** Режим профиля в момент события: regular (PvP) / pve. */
    mode?: string;
}

export interface LogState {
    /** nameId карты из последней строки создания рейда, например «TarkovStreets». */
    mapNameId?: string;
    /** Время начала рейда по логу (мс). */
    raidStart?: number;
    /** Время последнего выхода из рейда (UserMatchOver), мс. */
    raidEnd?: number;
    /** Короткий id рейда из строки создания рейда. */
    raidId?: string;
    /** Режим последней сессии игры: regular / pve. */
    sessionMode?: string;
    /** События квестов текущей сессии игры. */
    taskEvents: TaskEvent[];
    logFile?: string;
}

// «2024-06-10 14:35:12.123 +03:00|0.15.0.0.1234|Info|application|…» — пояс бывает не всегда
const PREFIX = String.raw`^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2})\.\d+(?: [+-]\d{2}:\d{2})?\|`;
const LOCATION_RE = new RegExp(PREFIX + String.raw`.*TRACE-NetworkGameCreate.*?Location: ([^,\s]+)`, "gm");
const MODE_RE = new RegExp(PREFIX + String.raw`.*Session mode: ([A-Za-z]+)`, "gm");
const LINE_TIME_RE = new RegExp(PREFIX);

const toTime = (d: string, t: string) => new Date(`${d}T${t}`).getTime();

function parseModes(appText: string): [number, string][] {
    const out: [number, string][] = [];
    MODE_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = MODE_RE.exec(appText))) out.push([toTime(m[1], m[2]), m[3].toLowerCase()]);
    return out;
}

function modeAt(modes: [number, string][], t: number) {
    let mode: string | undefined;
    for (const [mt, md] of modes) if (mt <= t) mode = md;
    return mode ?? modes[0]?.[1];
}

/** Время последнего «Got notification | UserMatchOver» — игрок вышел из рейда. */
export function parseRaidEnd(notifText: string): number | undefined {
    let last: number | undefined;
    for (const line of notifText.split(/\r?\n/)) {
        if (!line.includes("UserMatchOver")) continue;
        const tm = LINE_TIME_RE.exec(line);
        if (tm) last = toTime(tm[1], tm[2]);
    }
    return last;
}

export function parseTaskEvents(notifText: string, modes: [number, string][]): TaskEvent[] {
    const out: TaskEvent[] = [];
    const lines = notifText.split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
        if (!lines[i].includes("ChatMessageReceived")) continue;
        const tm = LINE_TIME_RE.exec(lines[i]);
        if (!tm || lines[i + 1]?.trim() !== "{") continue;
        const buf: string[] = [];
        let j = i + 1;
        for (; j < lines.length; j++) {
            buf.push(lines[j]);
            if (lines[j].startsWith("}")) break;
        }
        i = j;
        try {
            const msg = JSON.parse(buf.join("\n"))?.message;
            const type = msg?.type;
            if (type !== 10 && type !== 11 && type !== 12) continue;
            const taskId = String(msg.templateId ?? "").split(" ")[0];
            if (!/^[0-9a-f]{24}$/.test(taskId)) continue;
            const time = toTime(tm[1], tm[2]);
            out.push({ taskId, status: type === 10 ? "started" : type === 11 ? "failed" : "finished", time, mode: modeAt(modes, time) });
        } catch {
            /* обрывок JSON в конце файла — дочитаем на следующем проходе */
        }
    }
    return out;
}

async function readFiles(dir: FileSystemDirectoryHandle, test: (name: string) => boolean) {
    const out: { name: string; text: string }[] = [];
    for await (const [name, h] of dir.entries()) {
        if (h.kind !== "file" || !test(name)) continue;
        out.push({ name, text: await (await (h as FileSystemFileHandle).getFile()).text() });
    }
    return out.sort((a, b) => a.name.localeCompare(b.name));
}

const isApp = (n: string) => /application.*\.log$/i.test(n);
const isNotif = (n: string) => /notifications.*\.log$/i.test(n);

async function sessionDirs(dir: FileSystemDirectoryHandle) {
    const names: string[] = [];
    for await (const [name, h] of dir.entries()) if (h.kind === "directory" && name.startsWith("log_")) names.push(name);
    return names.sort();
}

/** Все события квестов из всех сохранённых сессий игры — для первичной синхронизации. */
export async function scanTaskHistory(dir: FileSystemDirectoryHandle, onProgress?: (done: number, total: number) => void): Promise<TaskEvent[]> {
    const sessions = await sessionDirs(dir);
    const all: TaskEvent[] = [];
    for (let i = 0; i < sessions.length; i++) {
        onProgress?.(i, sessions.length);
        const sub = await dir.getDirectoryHandle(sessions[i]);
        const notif = await readFiles(sub, isNotif);
        if (!notif.some((n) => n.text.includes("ChatMessageReceived"))) continue;
        const modes = (await readFiles(sub, isApp)).flatMap((a) => parseModes(a.text));
        for (const n of notif) all.push(...parseTaskEvents(n.text, modes));
    }
    onProgress?.(sessions.length, sessions.length);
    return all.sort((a, b) => a.time - b.time);
}

/** Следит за последней сессией игры: карта, начало рейда, режим, события квестов. */
export function watchLogs(dir: FileSystemDirectoryHandle, onState: (s: LogState) => void, onError: (e: Error) => void, interval = 3000) {
    let stopped = false;
    let lastKey = "";

    const tick = async () => {
        try {
            const sessions = await sessionDirs(dir);
            const latest = sessions[sessions.length - 1];
            if (latest) {
                const sub = await dir.getDirectoryHandle(latest);
                const sizes: string[] = [];
                for await (const [name, h] of sub.entries()) {
                    if (h.kind !== "file" || !(isApp(name) || isNotif(name))) continue;
                    sizes.push(`${name}:${(await (h as FileSystemFileHandle).getFile()).size}`);
                }
                const key = latest + "|" + sizes.sort().join(",");
                if (key !== lastKey) {
                    lastKey = key;
                    const appText = (await readFiles(sub, isApp)).map((a) => a.text.slice(-3_000_000)).join("\n");
                    const notif = await readFiles(sub, isNotif);
                    let m: RegExpExecArray | null;
                    let last: RegExpExecArray | null = null;
                    LOCATION_RE.lastIndex = 0;
                    while ((m = LOCATION_RE.exec(appText))) last = m;
                    const modes = parseModes(appText);
                    onState({
                        mapNameId: last?.[3],
                        raidStart: last ? toTime(last[1], last[2]) : undefined,
                        raidId: last ? /shortId: ([A-Z0-9]{4,})/.exec(last[0])?.[1] : undefined,
                        raidEnd: notif.map((n) => parseRaidEnd(n.text)).reduce<number | undefined>((a, b) => (b && (!a || b > a) ? b : a), undefined),
                        sessionMode: modes[modes.length - 1]?.[1],
                        taskEvents: notif.flatMap((n) => parseTaskEvents(n.text, modes)),
                        logFile: latest,
                    });
                }
            }
        } catch (e) {
            onError(e as Error);
        }
        if (!stopped) setTimeout(tick, interval);
    };
    tick();
    return () => {
        stopped = true;
    };
}
