import { useEffect, useState } from "react";
import { desktop } from "../lib/desktop";

/** Кнопки окна для безрамочного десктоп-приложения: свернуть, развернуть, закрыть. */
export default function WindowControls() {
    const [max, setMax] = useState(false);
    useEffect(() => {
        if (!desktop) return;
        desktop.win.isMaximized().then(setMax);
        return desktop.win.onState((s) => setMax(s.maximized));
    }, []);
    if (!desktop) return null;
    return (
        <div className="win-controls">
            <button title="Свернуть" onClick={() => desktop!.win.minimize()}>
                <svg viewBox="0 0 10 10">
                    <path d="M1 5.5h8" />
                </svg>
            </button>
            <button title={max ? "Восстановить" : "Развернуть"} onClick={() => desktop!.win.toggleMaximize()}>
                <svg viewBox="0 0 10 10">{max ? <path d="M2.5 1.5h6v6M1.5 2.5h6v6h-6z" /> : <path d="M1.5 1.5h7v7h-7z" />}</svg>
            </button>
            <button className="close" title="Закрыть" onClick={() => desktop!.win.close()}>
                <svg viewBox="0 0 10 10">
                    <path d="M1.5 1.5l7 7M8.5 1.5l-7 7" />
                </svg>
            </button>
        </div>
    );
}
