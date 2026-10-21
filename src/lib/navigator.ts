// Навигатор: позиция игрока по скриншотам игры и текущая карта по логам.
//
// Как это работает (тот же принцип, что у Tarkov Pilot и TarkovMonitor):
//  - При нажатии клавиши скриншота игра сохраняет PNG в «Документы\Escape From Tarkov\Screenshots»,
//    а в имя файла записывает координаты и поворот камеры:
//      2024-06-10[14-37]_-185.82, 2.47, 97.37_0.03201, -0.56732, 0.02200, 0.82254_16.33 (0).png
//  - Игра пишет текстовые логи; строка «TRACE-NetworkGameCreate … Location: TarkovStreets»
//    сообщает, на какую карту загружается рейд.
//
// Приложение только читает ИМЕНА файлов в папке, которую пользователь сам выбрал в браузере
// (File System Access API, Chrome/Edge), и текст логов. С процессом игры никак не взаимодействует.

import type { Vec3 } from "../types";

export interface PlayerFix {
    position: Vec3;
    /** Направление взгляда: градусы по часовой от +z к +x в координатах игры. */
    heading?: number;
    /** Единичный вектор взгляда в плоскости x/z. */
    forward?: { x: number; z: number };
    /** Время получения (мс). */
    time: number;
    file: string;
}

const NAME_RE = /^\d{4}-\d{2}-\d{2}\[\d{2}-\d{2}\]_?(.+?) \(\d+\)\.png$/i;
const NUM = String.raw`(-?\d+(?:\.\d+)?)`;
const POS_RE = new RegExp(`${NUM}, ${NUM}, ${NUM}_?${NUM}, ${NUM}, ${NUM}, ${NUM}`);
const POS_ONLY_RE = new RegExp(`${NUM}, ${NUM}, ${NUM}`);

/** Разбор имени скриншота. null — не скриншот с координатами. */
export function parseScreenshotName(file: string): Omit<PlayerFix, "time"> | null {
    const m = NAME_RE.exec(file);
    if (!m) return null;
    const full = POS_RE.exec(m[1]);
    if (full) {
        const [x, y, z, qx, qy, qz, qw] = full.slice(1).map(Number);
        // «Вперёд» в Unity — ось +z, повёрнутая кватернионом.
        const fx = 2 * (qx * qz + qw * qy);
        const fz = 1 - 2 * (qx * qx + qy * qy);
        const len = Math.hypot(fx, fz) || 1;
        return {
            position: { x, y, z },
            forward: { x: fx / len, z: fz / len },
            heading: (Math.atan2(fx, fz) * 180) / Math.PI,
            file,
        };
    }
    const p = POS_ONLY_RE.exec(m[1]);
    if (!p) return null;
    const [x, y, z] = p.slice(1).map(Number);
    return { position: { x, y, z }, file };
}

/** Угол от направления взгляда до цели: + — повернуть направо, − — налево (градусы). */
export function relativeBearing(fix: PlayerFix, target: Vec3): number | undefined {
    if (fix.heading === undefined) return undefined;
    const bearing = (Math.atan2(target.x - fix.position.x, target.z - fix.position.z) * 180) / Math.PI;
    let d = bearing - fix.heading;
    while (d > 180) d -= 360;
    while (d < -180) d += 360;
    return d;
}

// ---------------- File System Access ----------------

export const fsSupported = () => typeof window !== "undefined" && "showDirectoryPicker" in window;

export async function pickDirectory(id: string): Promise<FileSystemDirectoryHandle> {
    return window.showDirectoryPicker!({ id, mode: "read" });
}

export async function ensurePermission(h: FileSystemHandle, request: boolean): Promise<boolean> {
    const opts = { mode: "read" as const };
    if ((await h.queryPermission?.(opts)) === "granted") return true;
    if (!request) return false;
    return (await h.requestPermission?.(opts)) === "granted";
}

/**
 * Следит за папкой скриншотов: раз в interval мс ищет новые PNG.
 * Существующие на момент подключения файлы пропускаются.
 */
export function watchScreenshots(dir: FileSystemDirectoryHandle, onFix: (f: PlayerFix) => void, onError: (e: Error) => void, interval = 1000) {
    const seen = new Set<string>();
    let stopped = false;
    let first = true;

    const tick = async () => {
        try {
            const fresh: string[] = [];
            for await (const [name, h] of dir.entries()) {
                if (h.kind !== "file" || !name.toLowerCase().endsWith(".png")) continue;
                if (seen.has(name)) continue;
                seen.add(name);
                if (!first) fresh.push(name);
            }
            first = false;
            // имя начинается с даты и времени — последнее по алфавиту и есть самое новое
            const parsed = fresh.sort().map(parseScreenshotName).filter(Boolean) as Omit<PlayerFix, "time">[];
            const last = parsed[parsed.length - 1];
            if (last) onFix({ ...last, time: Date.now() });
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

// ---------------- хранение выбранных папок (IndexedDB) ----------------

const DB = "sherpa";
const STORE = "handles";

function db(): Promise<IDBDatabase> {
    return new Promise((resolve, reject) => {
        const r = indexedDB.open(DB, 1);
        r.onupgradeneeded = () => r.result.createObjectStore(STORE);
        r.onsuccess = () => resolve(r.result);
        r.onerror = () => reject(r.error);
    });
}

export async function saveHandle(key: string, h: FileSystemDirectoryHandle | undefined) {
    const d = await db();
    await new Promise<void>((resolve, reject) => {
        const tx = d.transaction(STORE, "readwrite");
        if (h) tx.objectStore(STORE).put(h, key);
        else tx.objectStore(STORE).delete(key);
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
    });
}

export async function loadHandle(key: string): Promise<FileSystemDirectoryHandle | undefined> {
    try {
        const d = await db();
        return await new Promise((resolve, reject) => {
            const r = d.transaction(STORE).objectStore(STORE).get(key);
            r.onsuccess = () => resolve(r.result);
            r.onerror = () => reject(r.error);
        });
    } catch {
        return undefined;
    }
}
