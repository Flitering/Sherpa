// Скачивает данные tarkov.dev и собирает компактные пакеты для приложения:
//   public/data/regular.json, public/data/pve.json  — квесты, карты, предметы
//   public/maps/svg/*.svg                            — SVG-подложки карт
//
// Запуск: npm run sync          (оба режима)
//         npm run sync -- pve   (только PvE)
//
// Скрипт только читает публичные данные из интернета. С игрой и её файлами не взаимодействует.

import { mkdir, writeFile, access } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT_DATA = join(ROOT, "public", "data");
const OUT_SVG = join(ROOT, "public", "maps", "svg");

const JSON_BASE = "https://json.tarkov.dev";
const MAP_CONFIG_URL = "https://raw.githubusercontent.com/the-hideout/tarkov-dev/main/src/data/maps.json";
const SVG_BASE = "https://raw.githubusercontent.com/the-hideout/tarkov-dev-svg-maps/main";
const LANG = "ru";

const modes = process.argv.slice(2).filter((a) => a === "regular" || a === "pve");
const MODES = modes.length ? modes : ["regular", "pve"];
const FORCE_SVG = process.argv.includes("--force-svg");

async function getJson(url) {
    for (let attempt = 1; ; attempt++) {
        try {
            const res = await fetch(url, { headers: { Accept: "application/json" } });
            if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
            return await res.json();
        } catch (e) {
            if (attempt >= 3) throw new Error(`Не удалось скачать ${url}: ${e.message}`);
            await new Promise((r) => setTimeout(r, 1500 * attempt));
        }
    }
}

async function getText(url) {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`${res.status} ${res.statusText} — ${url}`);
    return res.text();
}

const exists = (p) => access(p).then(() => true, () => false);

/** Перевод строки: сначала ru, затем en, затем сам ключ. */
function translator(...dicts) {
    return (key) => {
        if (key == null) return key;
        for (const d of dicts) if (d && d[key] != null) return d[key];
        return key;
    };
}

const round = (n) => Math.round(n * 100) / 100;
const pos = (p) => (p ? { x: round(p.x), y: round(p.y), z: round(p.z) } : undefined);
const outline = (o) => (o?.length ? o.map((p) => [round(p.x), round(p.z)]) : undefined);

// ---------- конфигурация отображения карт (из исходников tarkov.dev) ----------

async function loadMapConfigs() {
    const groups = await getJson(MAP_CONFIG_URL);
    const svgFiles = new Set();
    const configs = [];
    for (const g of groups) {
        const m = g.maps.find((x) => x.projection === "interactive");
        if (!m) continue;
        let svgPath;
        if (m.svgPath) {
            const file = m.svgPath.split("/").pop();
            svgFiles.add(file);
            svgPath = `maps/svg/${file}`;
        }
        configs.push({
            key: m.key,
            altMaps: m.altMaps ?? [],
            transform: m.transform,
            coordinateRotation: m.coordinateRotation ?? 0,
            bounds: m.bounds,
            svgBounds: m.svgBounds,
            svgPath,
            svgLayer: m.svgLayer,
            tilePath: m.tilePath,
            tileSize: m.tileSize,
            minZoom: m.minZoom,
            maxZoom: m.maxZoom,
            heightRange: m.heightRange,
            layers: (m.layers ?? []).map((l) => ({
                name: l.name,
                svgLayer: l.svgLayer,
                tilePath: l.tilePath,
                show: !!l.show,
                extents: l.extents,
            })),
            labels: (m.labels ?? []).map((l) => ({
                x: l.position[0],
                z: l.position[1],
                text: l.text,
                rotation: l.rotation ?? 0,
                size: l.size ?? 100,
            })),
            author: m.author,
            authorLink: m.authorLink,
        });
    }
    return { configs, svgFiles: [...svgFiles] };
}

async function downloadSvgs(files) {
    await mkdir(OUT_SVG, { recursive: true });
    for (const file of files) {
        const target = join(OUT_SVG, file);
        if (!FORCE_SVG && (await exists(target))) continue;
        process.stdout.write(`  карта ${file}… `);
        await writeFile(target, await getText(`${SVG_BASE}/${file}`));
        console.log("ok");
    }
}

// ---------- сборка пакета для режима ----------

async function buildMode(mode, mapConfigs) {
    const get = (name) => getJson(`${JSON_BASE}/${mode}/${name}`);
    console.log(`[${mode}] скачиваю данные…`);
    const [tasks, tasksRu, tasksEn, maps, mapsRu, mapsEn, items, itemsRu, itemsEn, traders, tradersRu, tradersEn] =
        await Promise.all([
            get("tasks"), get(`tasks_${LANG}`), get("tasks_en"),
            get("maps"), get(`maps_${LANG}`), get("maps_en"),
            get("items"), get(`items_${LANG}`), get("items_en"),
            get("traders"), get(`traders_${LANG}`), get("traders_en"),
        ]);

    const tt = translator(tasksRu.data, tasksEn.data);
    const mt = translator(mapsRu.data, mapsEn.data);
    const it = translator(itemsRu.data, itemsEn.data);
    const trt = translator(tradersRu.data, tradersEn.data);

    const usedItems = new Set();
    const useItem = (id) => {
        if (id) usedItems.add(id);
        return id;
    };

    // --- карты ---
    const rawMaps = Object.values(maps.data.maps);
    const outMaps = [];
    for (const cfg of mapConfigs) {
        const ids = [cfg.key, ...cfg.altMaps]
            .map((n) => rawMaps.find((m) => m.normalizedName === n))
            .filter(Boolean);
        const main = ids[0];
        if (!main) continue;
        outMaps.push({
            key: cfg.key,
            ids: ids.map((m) => m.id),
            name: mt(main.name),
            variants: ids.map((m) => ({ id: m.id, key: m.normalizedName, nameId: m.nameId, name: mt(m.name) })),
            wiki: main.wiki,
            raidDuration: main.raidDuration,
            players: main.players,
            minPlayerLevel: main.minPlayerLevel,
            bosses: [...new Set((main.bosses ?? []).map((b) => mt(b.mob)))],
            display: cfg,
            extracts: (main.extracts ?? []).map((e) => ({
                name: mt(e.name),
                faction: e.faction,
                position: pos(e.position),
                outline: outline(e.outline),
                top: e.top,
                bottom: e.bottom,
                // платный выход (предмет и количество) и выход, которому нужен рубильник
                paid: e.transferItem?.item ? { item: useItem(e.transferItem.item), count: e.transferItem.count } : undefined,
                needsSwitch: e.switch === true || undefined,
            })),
            hazards: (main.hazards ?? []).map((h) => ({
                type: h.hazardType,
                name: mt(h.name),
                position: pos(h.position),
                outline: outline(h.outline),
                top: h.top != null ? round(h.top) : undefined,
                bottom: h.bottom != null ? round(h.bottom) : undefined,
            })),
            stationary: (main.stationaryWeapons ?? []).map((w) => {
                const def = maps.data.stationaryWeapons?.[w.stationaryWeapon];
                const nn = def?.normalizedName ?? "";
                return { type: nn.includes("ags") ? "ags" : nn.includes("utyos") || nn.includes("nsv") ? "utes" : "mg", name: mt(def?.shortName ?? def?.name ?? ""), position: pos(w.position) };
            }),
            artillery: (main.artillery?.zones ?? []).map((z) => ({ position: pos(z.position), outline: outline(z.outline) })),
            transits: (main.transits ?? []).map((t) => ({
                name: mt(t.description),
                position: pos(t.position),
                outline: outline(t.outline),
            })),
            spawns: (main.spawns ?? [])
                .filter((s) => s.sides.includes("pmc") && s.categories.includes("player"))
                .map((s) => ({ zone: s.zoneName, position: pos(s.position) })),
        });
    }
    const mapIdToKey = Object.fromEntries(outMaps.flatMap((m) => m.ids.map((id) => [id, m.key])));

    // --- квесты ---
    const questItems = tasks.data.questItems;
    const zoneOut = (z) => ({
        map: mapIdToKey[z.map],
        position: pos(z.position),
        outline: outline(z.outline),
        top: z.top != null ? round(z.top) : undefined,
        bottom: z.bottom != null ? round(z.bottom) : undefined,
    });
    // У Ground Zero и Ground Zero 21+ одинаковые зоны: убираем дубли после сведения к одной карте.
    const dedupe = (list, keyFn) => {
        const seen = new Set();
        return list.filter((x) => {
            const k = keyFn(x);
            if (seen.has(k)) return false;
            seen.add(k);
            return true;
        });
    };

    const outTasks = Object.values(tasks.data.tasks).map((t) => ({
        id: t.id,
        name: tt(t.name),
        trader: t.trader,
        map: mapIdToKey[t.map] ?? null,
        minPlayerLevel: t.minPlayerLevel,
        // условия открытия: уровень доверия торговца и сюжетные условия (диалог, глобальная переменная)
        traderReq: (t.traderRequirements ?? []).map((r) => ({ trader: r.trader, type: r.requirementType, value: r.value })),
        story: (t.otherRequirements ?? []).length > 0 || undefined,
        kappa: !!t.kappaRequired,
        lightkeeper: !!t.lightkeeperRequired,
        faction: t.factionName,
        wiki: t.wikiLink,
        image: t.taskImageLink,
        experience: t.experience,
        requires: (t.taskRequirements ?? []).map((r) => ({ task: r.task, status: r.status })),
        neededKeys: (t.neededKeys ?? []).map((k) => ({ map: mapIdToKey[k.map], keys: k.keys.map(useItem) })),
        objectives: t.objectives.map((o) => {
            const obj = {
                id: o.id,
                type: o.type,
                text: tt(o.description),
                optional: !!o.optional,
                count: o.count ?? undefined,
                maps: [...new Set((o.maps ?? []).map((m) => mapIdToKey[m]).filter(Boolean))],
            };
            if (o.zones?.length) {
                obj.zones = dedupe(o.zones.map(zoneOut).filter((z) => z.map && z.position), (z) =>
                    `${z.map}:${Math.round(z.position.x)}:${Math.round(z.position.z)}`);
            }
            if (o.possibleLocations?.length) {
                obj.locations = dedupe(
                    o.possibleLocations
                        .map((l) => ({ map: mapIdToKey[l.map], positions: l.positions.map(pos) }))
                        .filter((l) => l.map),
                    (l) => l.map,
                );
            }
            const itemIds = o.items ?? o.useAny ?? (o.item ? [o.item] : undefined);
            if (itemIds?.length) obj.items = itemIds.map(useItem);
            if (o.foundInRaid) obj.fir = true;
            if (o.markerItem) obj.markerItem = useItem(o.markerItem);
            if (o.questItem) obj.questItem = o.questItem;
            if (o.requiredKeys?.length) obj.keys = o.requiredKeys.map((alt) => alt.map(useItem));
            if (o.exitName) obj.exitName = mt(o.exitName);
            if (o.targetNames?.length) obj.targets = o.targetNames.map(tt);
            if (o.skill) obj.skill = { name: tt(o.skill), level: o.level };
            if (o.type === "taskStatus") obj.task = o.task;
            return obj;
        }),
    }));

    // --- предметы: только те, что встречаются в квестах ---
    const outItems = {};
    for (const id of usedItems) {
        const i = items.data.items[id];
        if (!i) continue;
        outItems[id] = {
            name: it(i.name),
            short: it(i.shortName),
            icon: i.iconLink,
            image: i.gridImageLink ?? i.iconLink,
            wiki: i.wikiLink,
            link: i.link,
        };
    }
    for (const q of Object.values(questItems)) {
        outItems[q.id] = {
            name: tt(q.name),
            short: tt(q.shortName),
            icon: q.iconLink,
            image: q.baseImageLink ?? q.iconLink,
            quest: true,
        };
    }

    const outTraders = Object.fromEntries(
        Object.values(traders.data).map((t) => [t.id, { name: trt(t.name), key: t.normalizedName, image: t.imageLink ?? t.image4xLink }]),
    );

    const bundle = {
        mode,
        lang: LANG,
        generatedAt: new Date().toISOString(),
        source: "tarkov.dev (json.tarkov.dev), карты — tarkov-dev-svg-maps (CC BY-NC-SA 4.0)",
        maps: outMaps,
        tasks: outTasks,
        items: outItems,
        traders: outTraders,
    };
    await mkdir(OUT_DATA, { recursive: true });
    const file = join(OUT_DATA, `${mode}.json`);
    await writeFile(file, JSON.stringify(bundle));
    // --- цены всех предметов (для подсказок и вкладки «Барахолка») ---
    const market = buildMarket(items.data, it);
    await writeFile(join(OUT_DATA, `${mode}-market.json`), JSON.stringify({ mode, generatedAt: new Date().toISOString(), ...market }));
    console.log(`[${mode}] цены: ${market.items.length} предметов`);
    const withZones = outTasks.filter((t) => t.objectives.some((o) => o.zones || o.locations)).length;
    console.log(`[${mode}] квестов: ${outTasks.length} (с точками на карте: ${withZones}), карт: ${outMaps.length}, предметов: ${Object.keys(outItems).length}`);
}

/**
 * Компактные цены: [id, имя, короткое, иконка, ширина, высота, базовая цена, последняя низкая,
 * средняя за 24ч, мин 24ч, макс 24ч, изменение за 48ч %, лотов, id торговца, цена торговца ₽, запрещён на барахолке].
 * Формат таблицей, чтобы файл был в разы меньше.
 */
export function buildMarket(data, tr) {
    const rows = [];
    for (const i of Object.values(data.items)) {
        if (i.types?.includes("preset")) continue;
        let best = null;
        for (const s of i.sellToTrader ?? []) if (!best || s.priceRUB > best.priceRUB) best = s;
        rows.push([
            i.id, tr(i.name), tr(i.shortName), i.iconLink ?? null, i.width, i.height, i.basePrice ?? 0,
            i.lastLowPrice ?? null, i.avg24hPrice ?? null, i.low24hPrice ?? null, i.high24hPrice ?? null,
            i.changeLast48hPercent ?? null, i.lastOfferCount ?? null, best?.trader ?? null, best?.priceRUB ?? null,
            i.types?.includes("noFlea") ? 1 : 0,
        ]);
    }
    const fm = data.fleaMarket ?? {};
    return {
        fleaMarket: { minPlayerLevel: fm.minPlayerLevel, offerFeeRate: fm.sellOfferFeeRate ?? 0.03, requirementFeeRate: fm.sellRequirementFeeRate ?? 0.03 },
        items: rows,
    };
}

const { configs, svgFiles } = await loadMapConfigs();
console.log(`Конфигурация карт: ${configs.length}`);
await downloadSvgs(svgFiles);
for (const mode of MODES) await buildMode(mode, configs);
console.log("Готово.");
