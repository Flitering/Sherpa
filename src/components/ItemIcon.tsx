import type { Bundle } from "../types";
import { useMarket } from "../lib/market";

export default function ItemIcon({ bundle, id, size = 32 }: { bundle: Bundle; id: string; size?: number }) {
    const { showTip, hideTip } = useMarket();
    const item = bundle.items[id];
    if (!item) return <span className="item-icon missing" style={{ width: size, height: size }} />;
    return (
        <a
            href={item.link ?? item.wiki}
            target="_blank"
            rel="noreferrer"
            className="item-icon"
            style={{ width: size, height: size }}
            onMouseEnter={(e) => showTip(id, e.currentTarget.getBoundingClientRect())}
            onMouseLeave={hideTip}
            aria-label={item.name}
        >
            {item.icon && <img src={item.icon} alt={item.short} loading="lazy" referrerPolicy="no-referrer" />}
        </a>
    );
}

export function itemName(bundle: Bundle, id: string) {
    return bundle.items[id]?.name ?? id;
}
