import { useEffect, useMemo, useState } from "react";
import type { GameMode } from "../types";
import { advise, DEMAND_RU, rub, useMarket, type MarketItem } from "../lib/market";
import { captureScreen, latestScreenshot, matchItems, normalize, recognize } from "../lib/ocr";

interface Props {
    mode: GameMode;
    onRefresh: () => Promise<void>;
    setIntel: (b: boolean) => void;
    shotsDir?: FileSystemDirectoryHandle;
}

interface LootRow {
    id: string;
    qty: number;
}

const LOOT_KEY = (mode: string) => `sherpa:loot:${mode}`;

function loadLoot(mode: string): LootRow[] {
    try {
        return JSON.parse(localStorage.getItem(LOOT_KEY(mode)) ?? "[]");
    } catch {
        return [];
    }
}

export default function MarketTab({ mode, onRefresh, setIntel, shotsDir }: Props) {
    const { market, intel, showTip, hideTip, traders } = useMarket();
    const [q, setQ] = useState("");
    const [loot, setLoot] = useState<LootRow[]>(() => loadLoot(mode));
    const [busy, setBusy] = useState<string>();
    const [note, setNote] = useState<string>();

    useEffect(() => setLoot(loadLoot(mode)), [mode]);
    useEffect(() => {
        try {
            localStorage.setItem(LOOT_KEY(mode), JSON.stringify(loot));
        } catch {
            /* приватный режим */
        }
    }, [loot, mode]);

    const results = useMemo(() => {
        if (!market) return [];
        const n = normalize(q);
        if (n.length < 2) return [];
        return market.list
            .filter((i) => normalize(i.name).includes(n) || normalize(i.short) === n || normalize(i.short).startsWith(n))
            .sort((a, b) => (b.avg24 ?? b.traderPrice ?? 0) - (a.avg24 ?? a.traderPrice ?? 0))
            .slice(0, 40);
    }, [market, q]);

    if (!market) return <div className="tab"><p className="empty">Загрузка цен…</p></div>;

    const add = (id: string, qty = 1) =>
        setLoot((l) => {
            const i = l.findIndex((x) => x.id === id);
            if (i >= 0) return l.map((x, k) => (k === i ? { ...x, qty: x.qty + qty } : x));
            return [...l, { id, qty }];
        });

    const lootRows = loot
        .map((r) => ({ ...r, item: market.byId.get(r.id)! }))
        .filter((r) => r.item)
        .map((r) => ({ ...r, a: advise(market, r.item, intel) }))
        .sort((x, y) => y.a.perSlot - x.a.perSlot);
    const total = lootRows.reduce((s, r) => s + r.a.value * r.qty, 0);

    const scan = async (get: () => Promise<Blob | ImageBitmap | null>) => {
        setNote(undefined);
        try {
            setBusy("получаю изображение…");
            const img = await get();
            if (!img) return setNote("Изображение не найдено.");
            const text = await recognize(img, setBusy);
            const items = Object.fromEntries(market.list.map((i) => [i.id, { name: i.name, short: i.short }]));
            const found = matchItems(items, text);
            found.forEach((f) => add(f.itemId, f.count));
            setNote(found.length ? `Добавлено позиций: ${found.length}. Проверь список — распознавание инвентаря пока неточное.` : "Предметы не распознаны.");
        } catch (e) {
            if ((e as Error).name !== "NotAllowedError") setNote("Ошибка: " + (e as Error).message);
        } finally {
            setBusy(undefined);
        }
    };

    const renderRow = ({ key, i, qty, onRemove, onQty }: { key: string; i: MarketItem; qty?: number; onRemove?: () => void; onQty?: (n: number) => void }) => {
        const a = advise(market, i, intel);
        return (
            <div className="mk-row" key={key}>
                <span className="item-icon" style={{ width: 40, height: 40 }} onMouseEnter={(e) => showTip(i.id, e.currentTarget.getBoundingClientRect())} onMouseLeave={hideTip}>
                    {i.icon && <img src={i.icon} alt="" loading="lazy" referrerPolicy="no-referrer" />}
                </span>
                <div className="mk-info">
                    <div className="name">{i.name}</div>
                    <div className="meta">
                        {i.noFlea ? <span className="warn">не продаётся на барахолке</span> : <>рынок {rub(i.lastLow)} · {DEMAND_RU[a.demand]}</>}
                        {i.trader && traders[i.trader] && <> · {traders[i.trader].name} {rub(i.traderPrice)}</>}
                    </div>
                    <div className={"mk-advice is-" + a.best}>
                        {a.best === "flea" && <>выставить за <b>{rub(a.fleaPrice)}</b> → чистыми {rub(a.fleaNet)}</>}
                        {a.best === "trader" && <>продать торговцу за <b>{rub(a.traderPrice)}</b></>}
                        {a.best === "none" && "нет цены"}
                        <span className="muted"> · {rub(a.perSlot)}/клетка</span>
                    </div>
                </div>
                {onQty ? (
                    <div className="mk-qty">
                        <input type="number" min={1} value={qty} onChange={(e) => onQty(Math.max(1, Number(e.target.value) || 1))} />
                        <button onClick={onRemove} title="Убрать">✕</button>
                    </div>
                ) : (
                    <button onClick={() => add(i.id)} title="В мой лут">+</button>
                )}
            </div>
        );
    };

    return (
        <div className="tab">
            <div className="panel-title">
                <span>Барахолка · {mode === "pve" ? "PvE" : "PvP"}</span>
                <small>цены от {new Date(market.updatedAt).toLocaleString("ru-RU")}</small>
            </div>
            <div className="row">
                <button
                    onClick={async () => {
                        setBusy("обновляю цены…");
                        try {
                            await onRefresh();
                            setNote("Цены обновлены с tarkov.dev.");
                        } catch (e) {
                            setNote("Не удалось обновить: " + (e as Error).message);
                        } finally {
                            setBusy(undefined);
                        }
                    }}
                    disabled={!!busy}
                >
                    ⟳ Обновить цены
                </button>
                <label className="check" title="Разведцентр 3 уровня снижает комиссию барахолки на 30%">
                    <input type="checkbox" checked={intel} onChange={(e) => setIntel(e.target.checked)} /> Разведцентр 3 ур.
                </label>
            </div>
            <input className="search" placeholder="Найти предмет: название или короткое имя" value={q} onChange={(e) => setQ(e.target.value)} />
            {results.map((i) => renderRow({ key: i.id, i }))}

            <div className="panel-title">
                <span>Мой лут</span>
                <small>
                    {lootRows.length} поз. · всего ≈ {rub(total)}
                </small>
            </div>
            <div className="row">
                <button onClick={() => scan(captureScreen)} disabled={!!busy}>🖥 Снимок инвентаря</button>
                {shotsDir && <button onClick={() => scan(() => latestScreenshot(shotsDir))} disabled={!!busy}>🖼 Последний скриншот</button>}
                <label className="button">
                    📂 Файл
                    <input type="file" accept="image/*" hidden onChange={(e) => e.target.files?.[0] && scan(async () => e.target.files![0])} />
                </label>
                {loot.length > 0 && <button onClick={() => confirm("Очистить список лута?") && setLoot([])}>Очистить</button>}
            </div>
            <p className="hint">Распознавание инвентаря — бета: читаются короткие названия в ячейках. Добавляй и поправляй вручную через поиск.</p>
            {busy && <div className="hint">⏳ {busy}</div>}
            {note && <div className="sync-note">{note}</div>}
            {lootRows.map((r) =>
                renderRow({
                    key: r.id,
                    i: r.item,
                    qty: r.qty,
                    onQty: (n) => setLoot((l) => l.map((x) => (x.id === r.id ? { ...x, qty: n } : x))),
                    onRemove: () => setLoot((l) => l.filter((x) => x.id !== r.id)),
                }),
            )}
            <p className="hint">
                Рекомендация: на 1% ниже самого дешёвого лота; если спрос растёт или лотов мало — ближе к средней за сутки (не выше +6%); если цена падает — на 3% ниже, чтобы
                ушло быстро. Комиссия считается по формуле игры. Торговец предлагается, если с барахолки выходит меньше чем на 5% выгоднее.
            </p>
        </div>
    );
}
