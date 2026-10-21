import type { Bundle } from "../types";
import type { Loadout, NeedEntry } from "../lib/quests";
import ItemIcon, { itemName } from "./ItemIcon";

export default function LoadoutTab({ bundle, loadout, mapName }: { bundle: Bundle; loadout: Loadout; mapName: string }) {
    return (
        <div className="tab">
            <Section title={`🔑 Ключи · ${mapName}`} bundle={bundle} list={loadout.keys} empty="Ключи не нужны." />
            <Section title={`🎒 Взять с собой · ${mapName}`} bundle={bundle} list={loadout.bring} empty="Маркеры и предметы для закладки не нужны." />
            <Section title={`🔍 Найти на карте · ${mapName}`} bundle={bundle} list={loadout.findOnMap} empty="Квестовых предметов на этой карте нет." />
            <Section title="📦 Сдать торговцам · все активные квесты" bundle={bundle} list={loadout.handIn} empty="Сдавать ничего не нужно." />
        </div>
    );
}

function Section({ title, bundle, list, empty }: { title: string; bundle: Bundle; list: NeedEntry[]; empty: string }) {
    return (
        <section className="need">
            <h3>{title}</h3>
            {list.length === 0 && <p className="empty">{empty}</p>}
            {list.map((n) => (
                <div className="need-row" key={(n.alternatives ?? [n.itemId]).join("|") + n.fir + n.reasons[0].task.id}>
                    <ItemIcon bundle={bundle} id={n.itemId} size={40} />
                    <div className="need-info">
                        <div className="name">
                            {itemName(bundle, n.itemId)}
                            {n.count > 1 && <b> ×{n.count}</b>}
                            {n.fir && <span className="badge fir">FIR</span>}
                        </div>
                        {n.alternatives && <div className="muted">или любой из {n.alternatives.length - 1} других</div>}
                        <div className="reasons">
                            {n.reasons.map((r, i) => (
                                <span key={i}>
                                    {r.task.name}
                                    {" "}
                                    {r.players.map((p) => (
                                        <span key={p.id} style={{ color: p.color }}>●</span>
                                    ))}
                                    {i < n.reasons.length - 1 ? "; " : ""}
                                </span>
                            ))}
                        </div>
                    </div>
                </div>
            ))}
        </section>
    );
}
