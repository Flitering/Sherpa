// Распознавание текста со скриншотов игры (Tesseract.js, работает в браузере, офлайн после первой загрузки
// языковых данных). Используется для списка заданий и (бета) для инвентаря.

import type { Bundle, Item } from "../types";

type TWorker = Awaited<ReturnType<typeof import("tesseract.js")["createWorker"]>>;
let workerPromise: Promise<TWorker> | null = null;

async function getWorker(onProgress?: (p: string) => void): Promise<TWorker> {
    if (!workerPromise) {
        workerPromise = (async () => {
            const { createWorker } = await import("tesseract.js");
            return createWorker(["rus", "eng"], 1, {
                logger: (m: { status: string; progress: number }) => onProgress?.(`${statusRu(m.status)} ${Math.round(m.progress * 100)}%`),
            });
        })();
        workerPromise.catch(() => (workerPromise = null));
    }
    return workerPromise;
}

const statusRu = (s: string) =>
    ({
        "loading tesseract core": "загрузка распознавателя",
        "initializing tesseract": "запуск",
        "loading language traineddata": "загрузка словарей",
        "initializing api": "подготовка",
        "recognizing text": "распознаю текст",
    })[s] ?? s;

/**
 * Подготовка снимка: светлый текст игры на тёмном фоне → тёмный текст на белом, увеличение ×2.
 * Tesseract так читает заметно лучше.
 */
export async function preprocess(src: Blob | HTMLCanvasElement | ImageBitmap): Promise<HTMLCanvasElement> {
    const bmp = src instanceof Blob ? await createImageBitmap(src) : src;
    const scale = Math.min(2, 4000 / Math.max(bmp.width, 1));
    const c = document.createElement("canvas");
    c.width = Math.round(bmp.width * scale);
    c.height = Math.round(bmp.height * scale);
    const ctx = c.getContext("2d", { willReadFrequently: true })!;
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(bmp, 0, 0, c.width, c.height);
    const img = ctx.getImageData(0, 0, c.width, c.height);
    const d = img.data;
    let sum = 0;
    for (let i = 0; i < d.length; i += 4) sum += d[i] * 0.3 + d[i + 1] * 0.59 + d[i + 2] * 0.11;
    const dark = sum / (d.length / 4) < 128;
    for (let i = 0; i < d.length; i += 4) {
        let v = d[i] * 0.3 + d[i + 1] * 0.59 + d[i + 2] * 0.11;
        if (dark) v = 255 - v;
        v = v < 150 ? Math.max(0, v - 40) : 255; // контраст
        d[i] = d[i + 1] = d[i + 2] = v;
    }
    ctx.putImageData(img, 0, 0);
    return c;
}

export async function recognize(src: Blob | HTMLCanvasElement | ImageBitmap, onProgress?: (p: string) => void): Promise<string> {
    const worker = await getWorker(onProgress);
    const canvas = await preprocess(src);
    const { data } = await worker.recognize(canvas);
    return data.text;
}

// ---------------- сопоставление с названиями ----------------

export const normalize = (s: string) =>
    s
        .toLowerCase()
        .replace(/ё/g, "е")
        .replace(/[^a-zа-я0-9]+/g, " ")
        .trim();

export function levenshtein(a: string, b: string): number {
    if (a === b) return 0;
    const m = a.length;
    const n = b.length;
    let prev = Array.from({ length: n + 1 }, (_, j) => j);
    for (let i = 1; i <= m; i++) {
        const cur = [i];
        for (let j = 1; j <= n; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
        prev = cur;
    }
    return prev[n];
}

export const similarity = (a: string, b: string) => 1 - levenshtein(a, b) / Math.max(a.length, b.length, 1);

/** Лучшая похожесть name на любой фрагмент строки line с тем же числом слов. */
function bestInLine(name: string, line: string): number {
    if (line.includes(name)) return 1;
    const nw = name.split(" ").length;
    const lw = line.split(" ");
    let best = 0;
    for (let k = Math.max(1, nw - 1); k <= nw + 1; k++) {
        for (let i = 0; i + k <= lw.length; i++) best = Math.max(best, similarity(name, lw.slice(i, i + k).join(" ")));
    }
    return best;
}

export interface TaskMatch {
    taskId: string;
    name: string;
    score: number;
    line: string;
}

/** Названия квестов, найденные в распознанном тексте. */
export function matchTasks(bundle: Bundle, text: string, threshold = 0.84): TaskMatch[] {
    const lines = text.split(/\n+/).map(normalize).filter((l) => l.length >= 3);
    const best = new Map<string, TaskMatch>();
    // длинные названия первыми: «Инвентаризация. Часть 2» важнее «Инвентаризация»
    const tasks = [...bundle.tasks].sort((a, b) => b.name.length - a.name.length);
    const usedLines = new Map<number, string[]>(); // строка → уже найденные в ней (более длинные) названия
    for (const t of tasks) {
        const name = normalize(t.name);
        if (name.length < 4) continue;
        lines.forEach((line, li) => {
            const score = bestInLine(name, line);
            if (score < threshold) return;
            // «Инвентаризация» не считается, если в строке уже найдена «Инвентаризация. Часть 2»
            const taken = usedLines.get(li) ?? [];
            if (taken.some((longer) => longer !== name && longer.includes(name))) return;
            const prev = best.get(t.id);
            if (!prev || score > prev.score) best.set(t.id, { taskId: t.id, name: t.name, score, line });
            usedLines.set(li, [...taken, name]);
        });
    }
    // одинаковые названия (разные фракции и т.п.) — оставляем все, пользователь снимет лишнее
    return [...best.values()].sort((a, b) => b.score - a.score);
}

export interface ItemMatch {
    itemId: string;
    count: number;
}

/** Бета: короткие названия предметов в ячейках инвентаря. */
export function matchItems(items: Record<string, Item & { short: string }>, text: string): ItemMatch[] {
    const byShort = new Map<string, string>();
    for (const [id, it] of Object.entries(items)) {
        const s = normalize(it.short);
        if (s.length >= 3 && !byShort.has(s)) byShort.set(s, id);
    }
    const counts = new Map<string, number>();
    for (const token of normalize(text).split(" ")) {
        const id = byShort.get(token);
        if (id) counts.set(id, (counts.get(id) ?? 0) + 1);
    }
    return [...counts.entries()].map(([itemId, count]) => ({ itemId, count }));
}

// ---------------- источники изображения ----------------

/** Снимок экрана или окна игры (браузер спросит, что показать). */
export async function captureScreen(): Promise<ImageBitmap> {
    const stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: false });
    try {
        const video = document.createElement("video");
        video.srcObject = stream;
        video.muted = true;
        await video.play();
        await new Promise((r) => setTimeout(r, 300));
        return await createImageBitmap(video);
    } finally {
        stream.getTracks().forEach((t) => t.stop());
    }
}

/** Самый новый PNG из папки скриншотов игры. */
export async function latestScreenshot(dir: FileSystemDirectoryHandle): Promise<File | null> {
    // имена начинаются с даты и времени — самое новое последнее по алфавиту
    let bestName = "";
    let best: FileSystemFileHandle | null = null;
    for await (const [name, h] of dir.entries()) {
        if (h.kind !== "file" || !name.toLowerCase().endsWith(".png")) continue;
        if (name > bestName) {
            bestName = name;
            best = h as FileSystemFileHandle;
        }
    }
    return best ? best.getFile() : null;
}
