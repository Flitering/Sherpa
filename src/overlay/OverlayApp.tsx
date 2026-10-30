// Окно-виджет поверх игры: прозрачное, двигается за верхнюю полосу, меняет размер.
// Получает готовую модель от главного окна и только рисует её.

import { useEffect, useState } from "react";
import { desktop, type Hotkey, type OverlayState } from "../lib/desktop";
import { fmtClock, type HudModel, type OverlayModel, type RaidOffer } from "../lib/hudModel";
import MiniMap from "../components/MiniMap";

const LS = "sherpa:overlay:view";
interface View {
    compact: boolean;
    scale: number;
    radius: number;
}
const loadView = (): View => {
    try {
        return { compact: false, scale: 1, radius: 90, ...JSON.parse(localStorage.getItem(LS) ?? "{}") };
    } catch {
        return { compact: false, scale: 1, radius: 90 };
    }
};

function useNow() {
    const [now, setNow] = useState(Date.now());
    useEffect(() => {
        const t = setInterval(() => setNow(Date.now()), 1000);
        return () => clearInterval(t);
    }, []);
    return now;
}

export default function OverlayApp() {
    const [model, setModel] = useState<OverlayModel>({ kind: "idle" });
    const [st, setSt] = useState<OverlayState>({ opacity: 0.6, clickThrough: false, open: true });
    const [view, setView] = useState<View>(loadView);
    const [lockKey, setLockKey] = useState("");
    const now = useNow();

    useEffect(() => {
        if (!desktop) return;
        const pick = (l: Hotkey[]) => setLockKey(l.find((h) => h.id === "clickThrough")?.accelerator ?? "");
        desktop.hotkeys.get().then(pick);
        return desktop.hotkeys.onState(pick);
    }, []);

    useEffect(() => {
        if (!desktop) return;
        desktop.overlay.getState().then(setSt);
        const a = desktop.overlay.onModel((m) => setModel(m as OverlayModel));
        const b = desktop.overlay.onState(setSt);
        return () => {
            a();
            b();
        };
    }, []);
    useEffect(() => {
        try {
            localStorage.setItem(LS, JSON.stringify(view));
        } catch {
            /* не важно */
        }
    }, [view]);

    const act = desktop?.overlay.action ?? (() => {});
    const setOpacity = (d: number) => desktop?.overlay.set({ opacity: Math.round(Math.min(0.95, Math.max(0.15, st.opacity + d)) * 100) / 100 });
    const style = { "--alpha": st.opacity, "--scale": view.scale } as React.CSSProperties;

    return (
        <div className={"ov" + (st.clickThrough ? " locked" : "") + (view.compact ? " compact" : "")} style={style}>
            <header
                className="ov-head"
                onMouseEnter={() => desktop?.overlay.hoverHandle(true)}
                onMouseLeave={() => desktop?.overlay.hoverHandle(false)}
            >
                <span className="ov-grip" title="Перетащи, чтобы передвинуть">⠿</span>
                <span className="ov-title" style={model.kind === "hud" ? { color: model.hud.raid.color } : undefined}>
                    {model.kind === "hud" ? model.hud.raid.name : model.kind === "offer" ? "Рейд начался" : "Sherpa"}
                </span>
                {model.kind === "hud" && (
                    <span className={"ov-timer" + ((now - model.hud.timerStart) / 1000 > model.hud.raidSec * 0.85 ? " late" : "")}>
                        {fmtClock((now - model.hud.timerStart) / 1000)}
                        <small> / {fmtClock(model.hud.raidSec)}</small>
                    </span>
                )}
                <span className="ov-tools">
                    <button title="Компактный вид" onClick={() => setView({ ...view, compact: !view.compact })}>
                        {view.compact ? "▣" : "▭"}
                    </button>
                    <button title="Прозрачнее" onClick={() => setOpacity(-0.1)}>
                        ◌
                    </button>
                    <button title="Плотнее" onClick={() => setOpacity(0.1)}>
                        ●
                    </button>
                    <button title="Мельче" onClick={() => setView({ ...view, scale: Math.max(0.7, +(view.scale - 0.1).toFixed(2)) })}>
                        A−
                    </button>
                    <button title="Крупнее" onClick={() => setView({ ...view, scale: Math.min(1.8, +(view.scale + 0.1).toFixed(2)) })}>
                        A+
                    </button>
                    <button
                        className={st.clickThrough ? "on" : ""}
                        title={
                            st.clickThrough
                                ? `Клики проходят в игру.${lockKey ? ` ${lockKey} — вернуть` : ""}`
                                : `Пропускать клики в игру${lockKey ? ` (${lockKey})` : ""}`
                        }
                        onClick={() => desktop?.overlay.set({ clickThrough: !st.clickThrough })}
                    >
                        {st.clickThrough ? "🔒" : "🔓"}
                    </button>
                    <button title="Открыть Sherpa" onClick={() => act({ type: "openMain" })}>
                        ⧉
                    </button>
                    <button title="Скрыть виджет (Ctrl+Shift+N — показать)" onClick={() => desktop?.overlay.close()}>
                        ✕
                    </button>
                </span>
            </header>

            {model.kind === "idle" && (
                <div className="ov-panel ov-idle">
                    <b>Навигатор ждёт рейда.</b>
                    <span>Зайди в рейд — здесь появится предложение маршрута.</span>
                    <span className="ov-muted">Ctrl+Shift+N — показать или скрыть виджет</span>
                </div>
            )}
            {model.kind === "offer" && <Offer offer={model.offer} act={act} />}
            {model.kind === "hud" && <HudView hud={model.hud} now={now} view={view} setRadius={(radius) => setView({ ...view, radius })} act={act} />}
        </div>
    );
}

function Offer({ offer, act }: { offer: RaidOffer; act: (a: Parameters<NonNullable<typeof desktop>["overlay"]["action"]>[0]) => void }) {
    return (
        <div className="ov-panel ov-offer">
            <div className="ov-offer-title">
                ⚑ <b>{offer.mapName}</b> · {new Date(offer.startedAt).toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" })}
            </div>
            {offer.note && <div className="ov-note">{offer.note}</div>}
            {offer.raids.length ? (
                <>
                    <span className="ov-muted">Выбери маршрут:</span>
                    {offer.raids.map((r) => (
                        <button key={r.index} className={"ov-raid" + (r.index === offer.defaultRaid ? " def" : "")} style={{ "--rc": r.color } as React.CSSProperties} onClick={() => act({ type: "start", raid: r.index })}>
                            <span className="ov-raid-no">{r.index + 1}</span>
                            <span className="ov-raid-name">
                                {r.name}
                                {r.best && <i> ★</i>}
                            </span>
                            <span className="ov-muted">
                                {r.steps} точ. · ~{r.time}
                            </span>
                        </button>
                    ))}
                </>
            ) : (
                <span className="ov-muted">На этой карте нет целей у активных квестов.</span>
            )}
            <button className="ov-link" onClick={() => act({ type: "dismiss" })}>
                не сейчас
            </button>
        </div>
    );
}

function HudView({ hud, now, view, setRadius, act }: { hud: HudModel; now: number; view: View; setRadius: (r: number) => void; act: (a: { type: "done" } | { type: "skip" } | { type: "empty" } | { type: "stop" }) => void }) {
    const age = hud.fix ? Math.round((now - hud.fix.time) / 1000) : undefined;
    return (
        <>
            <div className="ov-panel ov-nav">
                <div className={"ov-arrow" + (hud.arrived ? " arrived" : "")}>
                    {hud.arrived ? (
                        <span className="ov-here">НА МЕСТЕ</span>
                    ) : hud.arrowDeg !== undefined ? (
                        <svg viewBox="-50 -50 100 100" style={{ transform: `rotate(${hud.arrowDeg}deg)` }}>
                            <path d="M0 -44 L28 20 L0 7 L-28 20 Z" />
                        </svg>
                    ) : (
                        <span className="ov-noscr">
                            нажми
                            <br />
                            <b>{hud.screenshotKey}</b>
                        </span>
                    )}
                </div>
                <div className="ov-dist">
                    <div>
                        {hud.distance !== undefined ? (
                            <>
                                <b>{Math.round(hud.distance)}</b> м
                            </>
                        ) : (
                            <b>—</b>
                        )}
                    </div>
                    {hud.turnText && <div className="ov-turn">{hud.turnText}</div>}
                    {hud.floorText && <div className="ov-floor">{hud.floorText}</div>}
                    {hud.nextAction && <div className="ov-next">{hud.nextAction}</div>}
                    {hud.pathMin && <div className="ov-muted">≈ {hud.pathMin} мин пути</div>}
                </div>
            </div>

            {!view.compact && (
                <div className="ov-map" onWheel={(e) => setRadius(Math.min(400, Math.max(30, Math.round(view.radius * (e.deltaY > 0 ? 1.2 : 1 / 1.2)))))} title="Колесо мыши — масштаб">
                    <MiniMap display={hud.map.display} mapKey={hud.map.key} color={hud.raid.color} fix={hud.fix} points={hud.points} guide={hud.guide} extract={hud.extract} radius={view.radius} />
                </div>
            )}

            <div className="ov-panel ov-target">
                <div className="ov-step">
                    {hud.stepText}
                    {hud.behindMin > 0 && <span className="late"> · отстаём на {hud.behindMin} мин</span>}
                </div>
                <div className="ov-goal">{hud.goalName}</div>
                {hud.note && <div className="ov-note">{hud.note}</div>}
                {hud.spots && (
                    <div className="ov-spots">
                        мест осталось: {hud.spots.left}
                        {hud.spots.empty > 0 && ` · пустых: ${hud.spots.empty}`}
                    </div>
                )}
                {!view.compact && hud.objText && (
                    <div className="ov-obj">
                        <b>{hud.objType}</b> {hud.objText}
                    </div>
                )}
                {!view.compact && hud.players.length > 0 && (
                    <div className="ov-who">
                        {hud.players.map((p) => (
                            <span key={p.name} style={{ color: p.color }}>
                                ● {p.name}{" "}
                            </span>
                        ))}
                    </div>
                )}
                <div className="ov-actions">
                    {hud.hasTarget && (
                        <button className="primary" onClick={() => act({ type: "done" })} title="Ctrl+Shift+D">
                            ✓ Выполнено
                        </button>
                    )}
                    {hud.spots && (
                        <button onClick={() => act({ type: "empty" })} title="Предмета здесь нет — к следующему возможному месту">
                            ✗ Здесь нет
                        </button>
                    )}
                    {hud.hasTarget && !view.compact && (
                        <button onClick={() => act({ type: "skip" })} title="Ctrl+Shift+S">
                            Пропустить
                        </button>
                    )}
                    {!view.compact && <button onClick={() => act({ type: "stop" })}>Закончить</button>}
                </div>
                <div className="ov-foot">{age === undefined ? `Позиции ещё нет — нажми ${hud.screenshotKey} в игре` : `позиция ${age} с назад`}</div>
            </div>
        </>
    );
}
