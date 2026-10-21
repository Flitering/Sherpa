// Цены барахолки и торговцев: загрузка, обновление с tarkov.dev, комиссия и рекомендация.

import { createContext, useContext, useSyncExternalStore } from "react";
import type { GameMode } from "../types";

export interface MarketItem {
    id: string;
    name: string;
    short: string;
    icon?: string;
    w: number;
    h: number;
    base: number;
    lastLow: number | null;
    avg24: number | null;
    low24: number | null;
    high24: number | null;
    change48: number | null;
    offers: number | null;
    trader: string | null;
    traderPrice: number | null;
    noFlea: boolean;
}

export interface Market {
    mode: GameMode;
    updatedAt: string;
    offerFeeRate: number;
    requirementFeeRate: number;
    minPlayerLevel?: number;
    byId: Map<string, MarketItem>;
    list: MarketItem[];
}

type Row = [string, string, string, string | null, number, number, number, number | null, number | null, number | null, number | null, number | null, number | null, string | null, number | null, 0 | 1];

export async function loadMarket(mode: GameMode): Promise<Market> {
    const r = await fetch(`${import.meta.env.BASE_URL}data/${mode}-market.json`);
    if (!r.ok) throw new Error(`Нет файла цен (${r.status}). Запусти «npm run sync».`);
    const j = await r.json();
    const list: MarketItem[] = (j.items as Row[]).map((x) => ({
        id: x[0], name: x[1], short: x[2], icon: x[3] ?? undefined, w: x[4], h: x[5], base: x[6],
        lastLow: x[7], avg24: x[8], low24: x[9], high24: x[10], change48: x[11], offers: x[12],
        trader: x[13], traderPrice: x[14], noFlea: !!x[15],
    }));
    return {
        mode,
        updatedAt: j.generatedAt,
        offerFeeRate: j.fleaMarket?.offerFeeRate ?? 0.03,
        requirementFeeRate: j.fleaMarket?.requirementFeeRate ?? 0.03,
        minPlayerLevel: j.fleaMarket?.minPlayerLevel,
        byId: new Map(list.map((i) => [i.id, i])),
        list,
    };
}

/** Свежие цены прямо с json.tarkov.dev (CORS разрешён). Названия остаются из локального файла. */
export async function refreshMarket(m: Market): Promise<Market> {
    const r = await fetch(`https://json.tarkov.dev/${m.mode}/items`, { headers: { Accept: "application/json" } });
    if (!r.ok) throw new Error(`tarkov.dev ответил ${r.status}`);
    const j = await r.json();
    const items = j.data?.items ?? {};
    const list = m.list.map((old) => {
        const i = items[old.id];
        if (!i) return old;
        let best: { trader: string; priceRUB: number } | null = null;
        for (const s of i.sellToTrader ?? []) if (!best || s.priceRUB > best.priceRUB) best = s;
        return {
            ...old,
            base: i.basePrice ?? old.base,
            lastLow: i.lastLowPrice ?? null,
            avg24: i.avg24hPrice ?? null,
            low24: i.low24hPrice ?? null,
            high24: i.high24hPrice ?? null,
            change48: i.changeLast48hPercent ?? null,
            offers: i.lastOfferCount ?? null,
            trader: best?.trader ?? old.trader,
            traderPrice: best?.priceRUB ?? old.traderPrice,
        };
    });
    const fm = j.data?.fleaMarket;
    return {
        ...m,
        updatedAt: new Date().toISOString(),
        offerFeeRate: fm?.sellOfferFeeRate ?? m.offerFeeRate,
        requirementFeeRate: fm?.sellRequirementFeeRate ?? m.requirementFeeRate,
        byId: new Map(list.map((i) => [i.id, i])),
        list,
    };
}

/**
 * Комиссия барахолки (формула из вики EFT):
 *   fee = VO·Ti·4^PO·Q + VR·Tr·4^PR·Q, PO = log10(VO/VR), PR = log10(VR/VO);
 *   при VR < VO показатель PO возводится в 1.08, при VR ≥ VO — PR.
 * VO — базовая цена предмета, VR — запрошенная цена. Разведцентр 3 ур. снижает комиссию на 30%.
 */
export function fleaFee(m: Market, item: MarketItem, price: number, qty = 1, intel = false): number {
    const VO = Math.max(1, item.base);
    const VR = Math.max(1, price);
    let PO = Math.log10(VO / VR);
    let PR = Math.log10(VR / VO);
    if (VR < VO) PO = Math.pow(PO, 1.08);
    else PR = Math.pow(PR, 1.08);
    const fee = VO * m.offerFeeRate * Math.pow(4, PO) * qty + VR * m.requirementFeeRate * Math.pow(4, PR) * qty;
    return Math.round(fee * (intel ? 0.7 : 1));
}

export type Demand = "up" | "down" | "scarce" | "flat" | "unknown";

export interface Advice {
    demand: Demand;
    /** Рекомендуемая цена лота на барахолке (за штуку). */
    fleaPrice: number | null;
    fee: number | null;
    /** Чистыми с барахолки после комиссии. */
    fleaNet: number | null;
    traderPrice: number | null;
    best: "flea" | "trader" | "none";
    /** Лучшее значение за штуку и за клетку инвентаря. */
    value: number;
    perSlot: number;
}

const nice = (p: number) => (p >= 10000 ? Math.floor(p / 100) * 100 : Math.floor(p / 10) * 10);

export function advise(m: Market, item: MarketItem, intel = false): Advice {
    const ch = item.change48 ?? 0;
    const demand: Demand = item.lastLow == null && item.avg24 == null ? "unknown" : item.offers != null && item.offers < 8 ? "scarce" : ch >= 5 ? "up" : ch <= -5 ? "down" : "flat";
    const market = item.lastLow ?? item.avg24;
    let fleaPrice: number | null = null;
    let fee: number | null = null;
    let fleaNet: number | null = null;
    if (!item.noFlea && market) {
        // ажиотаж: растёт или дефицит — можно чуть выше рынка (до средней за сутки, не выше +6%);
        // падает — дешевле, чтобы продалось сразу; иначе — на 1% ниже самого дешёвого лота
        let target = market * 0.99;
        if (demand === "up" || demand === "scarce") target = Math.min(Math.max(market * 0.99, item.avg24 ?? 0), market * 1.06);
        else if (demand === "down") target = market * 0.97;
        // комиссия растёт быстрее цены, если цена сильно выше базовой — проверим и чуть ниже
        let best = { p: nice(target), net: -Infinity, fee: 0 };
        for (const k of [1, 0.97, 0.94, 0.9]) {
            const p = nice(target * k);
            const f = fleaFee(m, item, p, 1, intel);
            if (p - f > best.net + 1) best = { p, net: p - f, fee: f };
        }
        fleaPrice = best.p;
        fee = best.fee;
        fleaNet = best.net;
    }
    const tp = item.traderPrice;
    const best = fleaNet != null && (tp == null || fleaNet > tp * 1.05) ? "flea" : tp ? "trader" : "none";
    const value = best === "flea" ? fleaNet! : tp ?? 0;
    return { demand, fleaPrice, fee, fleaNet, traderPrice: tp, best, value, perSlot: Math.round(value / Math.max(1, item.w * item.h)) };
}

export const rub = (n: number | null | undefined) => (n == null ? "—" : `${Math.round(n).toLocaleString("ru-RU")} ₽`);

export const DEMAND_RU: Record<Demand, string> = {
    up: "▲ спрос растёт",
    down: "▼ цена падает",
    scarce: "◆ дефицит",
    flat: "стабильно",
    unknown: "нет данных",
};

// ---------------- подсказка по наведению: маленькое внешнее хранилище ----------------
// Наведение мыши не должно перерисовывать всё приложение — подписан только сам PriceTip.

export type Tip = { id: string; rect: DOMRect } | null;
let tip: Tip = null;
const listeners = new Set<() => void>();
export function showTip(id: string, rect: DOMRect) {
    tip = { id, rect };
    listeners.forEach((l) => l());
}
export function hideTip() {
    if (!tip) return;
    tip = null;
    listeners.forEach((l) => l());
}
export function useTip(): Tip {
    return useSyncExternalStore(
        (l) => {
            listeners.add(l);
            return () => listeners.delete(l);
        },
        () => tip,
    );
}

// ---------------- контекст для подсказок по наведению ----------------

export interface MarketCtx {
    market: Market | null;
    intel: boolean;
    traders: Record<string, { name: string }>;
    showTip: (id: string, rect: DOMRect) => void;
    hideTip: () => void;
}

export const MarketContext = createContext<MarketCtx>({ market: null, intel: false, traders: {}, showTip: () => {}, hideTip: () => {} });
export const useMarket = () => useContext(MarketContext);
