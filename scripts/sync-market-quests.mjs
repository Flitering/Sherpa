// Список квестов, которые сейчас есть в игре, — из публичного API tarkov-market.com.
// tarkov.dev не сразу убирает удалённые и переработанные квесты и не знает сюжетных глав,
// поэтому sync-data.mjs сверяет свои данные с этим списком (scripts/market-quests.json).
//
// Запуск: npm run sync:quests
// Нужен API-ключ PRO-аккаунта tarkov-market: переменная TARKOV_MARKET_KEY или файл .tarkov-market-key
// в корне проекта (он в .gitignore). Ключ даёт доступ к прогрессу персонажей — в репозиторий и в сборку
// он не попадает. В приложении ключ вводится в «Настройках» и хранится зашифрованным (electron/main.mjs).
//
// Лимиты API (https://tarkov-market.com/ru/dev/api): прогресс — 300 запросов/мин на ключ; здесь три запроса
// подряд с паузой, на 429 — ожидание Retry-After.

import { readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const API = "https://api.tarkov-market.app/api/v1";
const PAUSE_MS = 1000;

/** Запросы к API с паузой между ними и ожиданием при 429. */
function client(key, doFetch, log) {
    let last = 0;
    return async function get(path) {
        for (let attempt = 1; ; attempt++) {
            const wait = last + PAUSE_MS - Date.now();
            if (wait > 0) await new Promise((r) => setTimeout(r, wait));
            last = Date.now();
            const res = await doFetch(API + path, { headers: { "x-api-key": key, Accept: "application/json" } });
            if (res.status === 429 && attempt < 3) {
                const sec = Number(res.headers.get("retry-after")) || 60;
                log(`tarkov-market: лимит запросов, жду ${sec} с…`);
                await new Promise((r) => setTimeout(r, sec * 1000));
                continue;
            }
            if (res.status === 401) throw new Error("ключ tarkov-market не принят (неверный, отозван или нет PRO)");
            if (res.status === 403) throw new Error("для API tarkov-market нужен PRO-статус");
            if (!res.ok) throw new Error(`tarkov-market: ${res.status} — ${path}`);
            return res.json();
        }
    };
}

/** Персонажи владельца ключа — для проверки ключа. */
export async function marketCharacters({ key, fetch: doFetch = fetch, log = () => {} }) {
    const { characters } = await client(key, doFetch, log)("/characters");
    return characters.map((c) => ({ name: c.name, gameMode: c.gameMode }));
}

/** Скачать список квестов по режимам: { source, generatedAt, format, modes: { regular, pve } }. */
export async function fetchMarketQuests({ key, fetch: doFetch = fetch, log = () => {} }) {
    const get = client(key, doFetch, log);
    const { characters } = await get("/characters");
    const byMode = { regular: characters.find((c) => c.gameMode === "PVP"), pve: characters.find((c) => c.gameMode === "PVE") };
    if (!byMode.regular && !byMode.pve) throw new Error("на аккаунте tarkov-market нет персонажей PVP или PVE");

    const modes = {};
    for (const [mode, ch] of Object.entries(byMode)) {
        if (!ch) continue;
        const { quests } = await get(`/characters/${ch.charUid}/quests?lang=ru`);
        // только справочные поля: статус и прогресс персонажа не сохраняем
        modes[mode] = quests.map((q) => [q.questId, q.questIdAliases ?? [], q.name, q.trader ?? ""]);
        log(`tarkov-market [${mode}]: квестов ${quests.length}`);
    }
    // у аккаунта может не быть персонажа одного из режимов — тогда список общий
    modes.regular ??= modes.pve;
    modes.pve ??= modes.regular;
    return {
        source: "tarkov-market.com",
        generatedAt: new Date().toISOString(),
        format: "[id, алиасы id, название, торговец (англ.); пустой торговец — сюжетная глава]",
        modes,
    };
}

// запуск из командной строки: npm run sync:quests
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    let key = process.env.TARKOV_MARKET_KEY?.trim();
    if (!key) {
        try {
            key = (await readFile(join(ROOT, ".tarkov-market-key"), "utf8")).trim();
        } catch {
            throw new Error("Нет API-ключа: задай TARKOV_MARKET_KEY или положи ключ в файл .tarkov-market-key");
        }
    }
    const out = join(ROOT, "scripts", "market-quests.json");
    await writeFile(out, JSON.stringify(await fetchMarketQuests({ key, log: console.log })));
    console.log(`Готово: ${out}`);
}
