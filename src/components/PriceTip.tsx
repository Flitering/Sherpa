import { advise, DEMAND_RU, rub, useMarket } from "../lib/market";

/** Подсказка с ценами при наведении на иконку предмета. */
export default function PriceTip({ tip }: { tip: { id: string; rect: DOMRect } | null }) {
    const { market, intel, traders } = useMarket();
    if (!tip || !market) return null;
    const item = market.byId.get(tip.id);
    if (!item) return null;
    const a = advise(market, item, intel);
    const left = Math.min(window.innerWidth - 290, Math.max(8, tip.rect.left));
    const below = tip.rect.bottom + 230 < window.innerHeight;
    const style = below ? { left, top: tip.rect.bottom + 6 } : { left, bottom: window.innerHeight - tip.rect.top + 6 };
    return (
        <div className="price-tip" style={style}>
            <div className="pt-name">{item.name}</div>
            {item.noFlea ? (
                <div className="pt-row warn">Запрещён на барахолке</div>
            ) : (
                <>
                    <div className="pt-row">
                        <span>Барахолка (мин.)</span>
                        <b>{rub(item.lastLow)}</b>
                    </div>
                    <div className="pt-row">
                        <span>Средняя за 24 ч</span>
                        <b>{rub(item.avg24)}</b>
                    </div>
                    <div className="pt-row muted">
                        <span>
                            {DEMAND_RU[a.demand]}
                            {item.change48 != null && ` (${item.change48 > 0 ? "+" : ""}${item.change48.toFixed(1)}% за 48 ч)`}
                        </span>
                        <span>{item.offers != null ? `${item.offers} лотов` : ""}</span>
                    </div>
                </>
            )}
            <div className="pt-row">
                <span>Торговцу{item.trader && traders[item.trader] ? ` (${traders[item.trader].name})` : ""}</span>
                <b>{rub(item.traderPrice)}</b>
            </div>
            {a.fleaPrice != null && (
                <div className={"pt-advice is-" + a.best}>
                    {a.best === "flea" ? (
                        <>
                            Выставить за <b>{rub(a.fleaPrice)}</b>
                            <br />
                            чистыми {rub(a.fleaNet)} (комиссия {rub(a.fee)})
                        </>
                    ) : (
                        <>Выгоднее продать торговцу: {rub(a.traderPrice)}</>
                    )}
                </div>
            )}
            <div className="pt-row muted">
                <span>за клетку</span>
                <span>{rub(a.perSlot)}</span>
            </div>
        </div>
    );
}
