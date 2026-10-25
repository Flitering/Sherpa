import { useEffect, useState } from "react";
import type { PlayerFix } from "../lib/navigator";
import type { LogState } from "../lib/gamelogs";
import { fsSupported } from "../lib/navigator";
import { desktop, type OverlayState } from "../lib/desktop";
import { AppPanel, HotkeysEditor, PricePanel } from "./DesktopPanels";

export interface NavLink {
    status: "off" | "need-permission" | "on" | "error";
    name?: string;
    error?: string;
}

interface Props {
    shots: NavLink;
    logs: NavLink;
    connectShots: () => void;
    connectLogs: () => void;
    disconnect: (which: "shots" | "logs") => void;
    fix?: PlayerFix;
    log?: LogState;
    follow: boolean;
    setFollow: (b: boolean) => void;
    autoMap: boolean;
    setAutoMap: (b: boolean) => void;
    pipOpen: boolean;
    openPip: () => void;
    pipSupported: boolean;
    sessionActive: boolean;
    meName: string;
    autoSync: boolean;
    setAutoSync: (b: boolean) => void;
    onSyncHistory: () => void;
    syncNote?: string;
    historyProgress?: string;
    screenshotKey: string;
    setScreenshotKey: (k: string) => void;
    autoOverlay: boolean;
    setAutoOverlay: (b: boolean) => void;
    overlay: OverlayState;
    onDataUpdated: () => void;
}

/** «log_2026.10.22_22-32-15_…» → «22.10.2026 22:32». */
function sessionDate(folder: string) {
    const m = /log_(\d{4})\.(\d{2})\.(\d{2})_(\d{2})-(\d{2})/.exec(folder);
    return m ? `${m[3]}.${m[2]}.${m[1]} ${m[4]}:${m[5]}` : folder;
}

const STATUS = { off: "не найдено", "need-permission": "нужно разрешение", on: "подключено", error: "ошибка" };

export default function NavigatorTab(p: Props) {
    if (!desktop && !fsSupported()) {
        return (
            <div className="tab">
                <p className="empty">В этом браузере навигатор недоступен. Установи приложение Sherpa для Windows — в нём всё работает без настроек браузера.</p>
            </div>
        );
    }
    return (
        <div className="tab">
            <div className="panel-title">
                <span>Позиция по скриншотам</span>
            </div>
            <p className="hint">
                {desktop ? "Папка скриншотов игры находится автоматически. " : "Выбери папку Документы\\Escape From Tarkov\\Screenshots. "}
                Нажимай в рейде клавишу скриншота — игра запишет координаты и направление взгляда в имя файла, навигатор покажет тебя на карте. Подходит{" "}
                <b>любая</b> клавиша: приложение следит за новыми файлами, а не за клавиатурой.
            </p>
            <Link desktopMode={!!desktop} label="Скриншоты" link={p.shots} onConnect={p.connectShots} onOff={() => p.disconnect("shots")} />
            <label className="field">
                Клавиша скриншота в игре (для подсказок)
                <input value={p.screenshotKey} onChange={(e) => p.setScreenshotKey(e.target.value)} placeholder="Print Screen" />
            </label>
            {p.fix && (
                <div className="fix">
                    x {p.fix.position.x.toFixed(1)} · y {p.fix.position.y.toFixed(1)} · z {p.fix.position.z.toFixed(1)}
                    {p.fix.heading !== undefined && ` · взгляд ${Math.round(p.fix.heading)}°`}
                </div>
            )}

            <div className="panel-title">
                <span>Логи игры</span>
            </div>
            <p className="hint">Из логов — карта, начало и конец рейда, режим PvP/PvE и взятые/сданные квесты.</p>
            <Link desktopMode={!!desktop} label="Логи" link={p.logs} onConnect={p.connectLogs} onOff={() => p.disconnect("logs")} />
            {p.logs.status === "on" && (
                <div className="fix">
                    {p.log?.logFile ? (
                        <>
                            Сессия игры: <b>{sessionDate(p.log.logFile)}</b>
                            {p.log.mapNameId ? (
                                <>
                                    {" "}
                                    · последний рейд: <b>{p.log.mapNameId}</b>
                                    {p.log.raidStart && ` · ${p.log.raidConfirmed === false ? "поиск матча" : "начало"} ${new Date(p.log.raidStart).toLocaleTimeString("ru-RU")}`}
                                </>
                            ) : (
                                " · рейдов в ней пока нет"
                            )}
                        </>
                    ) : (
                        "В папке нет сессий игры — проверь, что выбрана папка Logs той игры, в которую играешь (в версии 1.0 это …\\build\\Logs)."
                    )}
                </div>
            )}
            {p.logs.status === "on" && (
                <>
                    <label className="check">
                        <input type="checkbox" checked={p.autoSync} onChange={(e) => p.setAutoSync(e.target.checked)} /> Отмечать квесты по логам (игрок «{p.meName}»)
                    </label>
                    <button onClick={p.onSyncHistory} disabled={!!p.historyProgress}>
                        {p.historyProgress ?? "⟳ Загрузить прогресс из всех логов игры"}
                    </button>
                    <div className="hint">Игра хранит логи только последних сессий: квесты, взятые раньше, по логам не найти — распознай список заданий со скриншота на вкладке «Квесты».</div>
                </>
            )}
            {p.syncNote && <div className="sync-note">{p.syncNote}</div>}

            <div className="panel-title">
                <span>Виджет поверх игры</span>
            </div>
            {desktop ? (
                <>
                    <p className="hint">
                        Прозрачное окно поверх игры с навигатором и миникартой. Двигай за верхнюю полосу, меняй размер за края. Игру запускай в режиме <b>«Оконный без рамки»</b>.
                    </p>
                    <div className="row">
                        <button className="primary" onClick={p.openPip} disabled={p.overlay.open}>
                            {p.overlay.open ? "Виджет открыт" : "Открыть виджет"}
                        </button>
                        {p.overlay.open && <button onClick={() => desktop!.overlay.close()}>Скрыть</button>}
                    </div>
                    <label className="check">
                        <input type="checkbox" checked={p.autoOverlay} onChange={(e) => p.setAutoOverlay(e.target.checked)} /> Открывать виджет, когда начинается рейд
                    </label>
                    <label className="field">
                        Прозрачность фона виджета: {Math.round((1 - p.overlay.opacity) * 100)}%
                        <input type="range" min={0.15} max={0.95} step={0.05} value={p.overlay.opacity} onChange={(e) => desktop!.overlay.set({ opacity: +e.target.value })} />
                    </label>
                    <label className="check">
                        <input type="checkbox" checked={p.overlay.clickThrough} onChange={(e) => desktop!.overlay.set({ clickThrough: e.target.checked })} /> Пропускать клики сквозь виджет в игру
                    </label>
                    <HotkeysEditor />
                </>
            ) : (
                <>
                    <button className="primary wide" disabled={!p.pipSupported || p.pipOpen || !p.sessionActive} onClick={p.openPip}>
                        {p.pipOpen ? "Окно открыто" : "Открыть окно навигатора"}
                    </button>
                    {!p.sessionActive && <p className="hint">Сначала запусти рейд на вкладке «Рейды».</p>}
                </>
            )}

            <div className="panel-title">
                <span>Отображение</span>
            </div>
            <label className="check">
                <input type="checkbox" checked={p.follow} onChange={(e) => p.setFollow(e.target.checked)} /> Карта следует за игроком
            </label>
            <label className="check">
                <input type="checkbox" checked={p.autoMap} onChange={(e) => p.setAutoMap(e.target.checked)} /> Переключать карту и PvP/PvE по логам
            </label>

            {desktop && <PricePanel />}

            {desktop && <DataPanel onUpdated={p.onDataUpdated} />}

            {desktop && <AppPanel />}

            <div className="panel-title">
                <span>Безопасность</span>
            </div>
            <p className="hint">
                Приложение читает только файлы, которые игра сама пишет на диск (имена скриншотов и логи), а для цены по наведению смотрит на экран так же, как запись
                экрана. Оно не трогает процесс игры, её память и ввод и ничего не удаляет.
            </p>
        </div>
    );
}

/** Обновление данных tarkov.dev (квесты, цены, карты) прямо из приложения. */
function DataPanel({ onUpdated }: { onUpdated: () => void }) {
    const [info, setInfo] = useState<{ lastSync: number | null; hasUserData: boolean }>();
    const [busy, setBusy] = useState(false);
    const [log, setLog] = useState<string[]>([]);
    useEffect(() => {
        desktop!.data.info().then(setInfo);
        return desktop!.data.onProgress((m) => setLog((l) => [...l.slice(-6), m]));
    }, []);
    return (
        <>
            <div className="panel-title">
                <span>Данные tarkov.dev</span>
                <small>{info?.lastSync ? `обновлено ${new Date(info.lastSync).toLocaleString("ru-RU")}` : "встроенные"}</small>
            </div>
            <p className="hint">Квесты, цены и карты меняются с патчами игры. Обновление занимает около минуты.</p>
            <button
                disabled={busy}
                onClick={async () => {
                    setBusy(true);
                    setLog([]);
                    try {
                        await desktop!.data.sync();
                        setInfo(await desktop!.data.info());
                        onUpdated();
                    } catch (e) {
                        setLog((l) => [...l, "Ошибка: " + (e as Error).message]);
                    } finally {
                        setBusy(false);
                    }
                }}
            >
                {busy ? "⏳ Обновляю…" : "⟳ Обновить данные"}
            </button>
            {log.length > 0 && <pre className="raw">{log.join("\n")}</pre>}
        </>
    );
}

function Link({ label, link, onConnect, onOff, desktopMode }: { label: string; link: NavLink; onConnect: () => void; onOff: () => void; desktopMode: boolean }) {
    return (
        <div className={"link-row " + link.status}>
            <span className="led" />
            <div className="link-info">
                <b>{label}</b>: {STATUS[link.status]}
                {link.name && <div className="muted path">{link.name}</div>}
                {link.error && <div className="warn">{link.error}</div>}
            </div>
            {desktopMode ? (
                <div className="row">
                    <button onClick={onConnect}>Выбрать…</button>
                    {link.status === "on" && (
                        <button onClick={onOff} title="Снова искать автоматически">
                            Авто
                        </button>
                    )}
                </div>
            ) : link.status === "on" ? (
                <button onClick={onOff}>Отключить</button>
            ) : (
                <button className="primary" onClick={onConnect}>
                    {link.status === "need-permission" ? "Разрешить" : "Выбрать папку"}
                </button>
            )}
        </div>
    );
}
