import { useState } from "react";
import type { RaidPlan } from "../lib/raids";
import { fmtMin } from "../lib/raids";

interface Props {
    mapName: string;
    startedAt: number;
    plan: RaidPlan;
    defaultRaid: number;
    /** overlay — открыть окно навигатора поверх игры (нужен клик пользователя — он и есть). */
    onStart: (raid: number, overlay: boolean) => void;
    onDismiss: () => void;
    /** От чего построен маршрут и какие выходы учтены. */
    note?: string;
}

/** Плашка «Рейд начался»: выбрать маршрут и открыть навигатор одним нажатием. */
export default function RaidPrompt({ mapName, startedAt, plan, defaultRaid, onStart, onDismiss, note }: Props) {
    const [raid, setRaid] = useState(defaultRaid);
    const has = plan.raids.length > 0;
    return (
        <div className="raid-prompt" role="alertdialog">
            <div className="rp-title">
                ⚑ Рейд начался · <b>{mapName}</b> · {new Date(startedAt).toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" })}
            </div>
            {note && <div className="rp-note">{note}</div>}
            {has ? (
                <>
                    <select value={raid} onChange={(e) => setRaid(+e.target.value)}>
                        {plan.raids.map((r) => (
                            <option key={r.index} value={r.index}>
                                {r.index + 1}. {r.name} — {r.steps.length} точек, ~{fmtMin(r.totalSec)}
                                {r.best ? " ★" : ""}
                            </option>
                        ))}
                    </select>
                    <div className="row">
                        <button className="primary" onClick={() => onStart(raid, true)}>
                            ▶ Навигатор поверх игры
                        </button>
                        <button onClick={() => onStart(raid, false)}>Только здесь</button>
                        <button className="link" onClick={onDismiss}>
                            не сейчас
                        </button>
                    </div>
                </>
            ) : (
                <div className="row">
                    <span className="muted">На этой карте нет целей у активных квестов.</span>
                    <button className="link" onClick={onDismiss}>
                        скрыть
                    </button>
                </div>
            )}
        </div>
    );
}
