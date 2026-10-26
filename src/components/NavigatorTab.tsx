import { fsSupported } from "../lib/navigator";
import { desktop, type OverlayState } from "../lib/desktop";
import { HotkeysEditor } from "./DesktopPanels";

export interface NavLink {
    status: "off" | "need-permission" | "on" | "error";
    name?: string;
    error?: string;
}

interface Props {
    shots: NavLink;
    logs: NavLink;
    /** Открыть вкладку «Настройки» (папки игры, логи и прочее). */
    openSettings: () => void;
    follow: boolean;
    setFollow: (b: boolean) => void;
    autoMap: boolean;
    setAutoMap: (b: boolean) => void;
    pipOpen: boolean;
    openPip: () => void;
    pipSupported: boolean;
    sessionActive: boolean;
    autoOverlay: boolean;
    setAutoOverlay: (b: boolean) => void;
    overlay: OverlayState;
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
            <div className="nav-status">
                <span className={"led " + p.shots.status} /> Скриншоты: {STATUS[p.shots.status]}
                <span className={"led " + p.logs.status} /> Логи: {STATUS[p.logs.status]}
                <button className="link" onClick={p.openSettings}>
                    настроить
                </button>
            </div>
            <p className="hint">Папки игры, логи, цена по наведению, обновление данных и ключ tarkov-market — на вкладке «Настройки».</p>

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
