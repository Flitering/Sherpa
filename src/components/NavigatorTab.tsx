import type { PlayerFix } from "../lib/navigator";
import type { LogState } from "../lib/gamelogs";
import { fsSupported } from "../lib/navigator";

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
}

const STATUS = { off: "не подключено", "need-permission": "нужно разрешение", on: "подключено", error: "ошибка" };

export default function NavigatorTab(p: Props) {
    if (!fsSupported()) {
        return (
            <div className="tab">
                <p className="empty">Навигатору нужен Chrome или Edge (File System Access API). В этом браузере он недоступен.</p>
            </div>
        );
    }
    return (
        <div className="tab">
            <div className="panel-title"><span>Позиция по скриншотам</span></div>
            <p className="hint">
                Выбери папку <code>Документы\Escape From Tarkov\Screenshots</code>. В рейде нажимай клавишу скриншота (по умолчанию <b>Print Screen</b>) — игра запишет координаты и
                направление взгляда в имя файла, а навигатор покажет тебя на карте.
            </p>
            <Link label="Скриншоты" link={p.shots} onConnect={p.connectShots} onOff={() => p.disconnect("shots")} />
            {p.fix && (
                <div className="fix">
                    x {p.fix.position.x.toFixed(1)} · y {p.fix.position.y.toFixed(1)} · z {p.fix.position.z.toFixed(1)}
                    {p.fix.heading !== undefined && ` · взгляд ${Math.round(p.fix.heading)}°`}
                </div>
            )}

            <div className="panel-title"><span>Карта по логам игры</span></div>
            <p className="hint">
                Выбери папку <code>Logs</code> в папке установки игры (например <code>C:\Battlestate Games\Escape from Tarkov\Logs</code>). Навигатор сам переключит карту и
                засечёт начало рейда.
            </p>
            <Link label="Логи" link={p.logs} onConnect={p.connectLogs} onOff={() => p.disconnect("logs")} />
            {p.log?.mapNameId && (
                <div className="fix">
                    Последний рейд: <b>{p.log.mapNameId}</b>
                    {p.log.raidStart && ` · начало ${new Date(p.log.raidStart).toLocaleTimeString("ru-RU")}`}
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
                    <p className="hint">
                        Игра пишет в логи сообщения «задание получено / выполнено / провалено». Из них приложение ставит статусы, а квесты-предшественники активных отмечает
                        выполненными. Учитываются события режима, выбранного сверху (PvP/PvE).
                    </p>
                </>
            )}
            {p.syncNote && <div className="sync-note">{p.syncNote}</div>}

            <div className="panel-title"><span>Отображение</span></div>
            <label className="check"><input type="checkbox" checked={p.follow} onChange={(e) => p.setFollow(e.target.checked)} /> Карта следует за игроком</label>
            <label className="check"><input type="checkbox" checked={p.autoMap} onChange={(e) => p.setAutoMap(e.target.checked)} /> Переключать карту по логам</label>

            <div className="panel-title"><span>Окно поверх игры</span></div>
            <p className="hint">
                Компактный навигатор в отдельном окне, которое всегда поверх остальных. Игру запускай в режиме <b>«Оконный без рамки»</b> — в полноэкранном режиме окна
                поверх не видны. Можно вынести окно на второй монитор.
            </p>
            <button className="primary wide" disabled={!p.pipSupported || p.pipOpen || !p.sessionActive} onClick={p.openPip}>
                {p.pipOpen ? "Окно открыто" : "Открыть окно навигатора"}
            </button>
            {!p.sessionActive && <p className="hint">Сначала запусти рейд на вкладке «Рейды».</p>}
            <p className="hint">
                В Chrome/Edge 116+ окно само держится поверх. В других браузерах откроется обычное окно — закрепить его поверх можно через PowerToys (Win+Ctrl+T).
            </p>

            <div className="panel-title"><span>Безопасность</span></div>
            <p className="hint">
                Навигатор только читает имена файлов скриншотов и текст логов, которые игра сама пишет на диск. Он не трогает процесс игры, её память и ввод, не встраивается
                в игру и ничего не удаляет.
            </p>
        </div>
    );
}

function Link({ label, link, onConnect, onOff }: { label: string; link: NavLink; onConnect: () => void; onOff: () => void }) {
    return (
        <div className={"link-row " + link.status}>
            <span className="led" />
            <div className="link-info">
                <b>{label}</b>: {STATUS[link.status]}
                {link.name && <span className="muted"> · {link.name}</span>}
                {link.error && <div className="warn">{link.error}</div>}
            </div>
            {link.status === "on" ? (
                <button onClick={onOff}>Отключить</button>
            ) : (
                <button className="primary" onClick={onConnect}>
                    {link.status === "need-permission" ? "Разрешить" : "Выбрать папку"}
                </button>
            )}
        </div>
    );
}
