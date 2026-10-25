// Список квестов, которые сейчас есть в игре, — из публичного API tarkov-market.com.
// tarkov.dev не сразу убирает удалённые и переработанные квесты и не знает сюжетных глав,
// поэтому sync-data.mjs сверяет свои данные с этим списком (scripts/market-quests.json).
//
// Запуск: npm run sync:quests
// Нужен API-ключ PRO-аккаунта tarkov-market: переменная TARKOV_MARKET_KEY или файл .tarkov-market-key
// в корне проекта (он в .gitignore). Ключ даёт доступ к прогрессу персонажей — в репозиторий и в сборку
// он не попадает, в приложении не используется.
//
// Лимиты API (https://tarkov-market.com/ru/dev/api): прогресс — 300 запросов/мин на ключ; скрипт делает
// три запроса подряд с паузой и на 429 ждёт Retry-After.

import { readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = join(ROOT, "scripts", "market-quests.json");
const API = "https://api.tarkov-market.app/api/v1";
const PAUSE_MS = 1000;

async function apiKey() {
    if (process.env.TARKOV_MARKET_KEY) return process.env.TARKOV_MARKET_KEY.trim();
    try {
        return (await readFile(join(ROOT, ".tarkov-market-key"), "utf8")).trim();
    } catch {
        throw new Error("Нет API-ключа: задай TARKOV_MARKET_KEY или положи ключ в файл .tarkov-market-key");
    }
}

let last = 0;
async function get(path, key) {
    for (let attempt = 1; ; attempt++) {
        const wait = last + PAUSE_MS - Date.now();
        if (wait > 0) await new Promise((r) => setTimeout(r, wait));
        last = Date.now();
        const res = await fetch(API + path, { headers: { "x-api-key": key, Accept: "application/json" } });
        if (res.status === 429 && attempt < 3) {
            const sec = Number(res.headers.get("retry-after")) || 60;
            console.log(`  лимит запросов, жду ${sec} с…`);
            await new Promise((r) => setTimeout(r, sec * 1000));
            continue;
        }
        if (!res.ok) throw new Error(`${res.status} ${await res.text()} — ${path}`);
        return res.json();
    }
}

const key = await apiKey();
const { characters } = await get("/characters", key);
const byMode = { regular: characters.find((c) => c.gameMode === "PVP"), pve: characters.find((c) => c.gameMode === "PVE") };
if (!byMode.regular && !byMode.pve) throw new Error("На аккаунте нет персонажей PVP или PVE");

const modes = {};
for (const [mode, ch] of Object.entries(byMode)) {
    if (!ch) continue;
    const { quests } = await get(`/characters/${ch.charUid}/quests?lang=ru`, key);
    // только справочные поля: статус и прогресс персонажа не сохраняем
    modes[mode] = quests.map((q) => [q.questId, q.questIdAliases ?? [], q.name, q.trader ?? ""]);
    console.log(`[${mode}] квестов: ${quests.length}`);
}
// у аккаунта может не быть персонажа одного из режимов — тогда список общий
modes.regular ??= modes.pve;
modes.pve ??= modes.regular;

await writeFile(
    OUT,
    JSON.stringify({
        source: "tarkov-market.com",
        generatedAt: new Date().toISOString(),
        format: "[id, алиасы id, название, торговец (англ.); пустой торговец — сюжетная глава]",
        modes,
    }),
);
console.log(`Готово: ${OUT}`);
