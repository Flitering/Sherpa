import { useEffect, useState } from "react";
import { desktop, type AppPrefs, type PriceState, type UpdateState } from "../lib/desktop";
import TermsModal from "./TermsModal";

/** Состояние обновления — общее для шапки и вкладки «Навигатор». */
export function useUpdate(): [UpdateState | undefined, () => void] {
    const [s, setS] = useState<UpdateState>();
    useEffect(() => {
        if (!desktop) return;
        desktop.update.get().then(setS);
        return desktop.update.onState(setS);
    }, []);
    const act = () => {
        if (!desktop || !s) return;
        if (s.status === "available") desktop.update.download();
        else if (s.status === "ready") desktop.update.install();
        else desktop.update.check();
    };
    return [s, act];
}

/** Кнопка в шапке: появляется, только когда есть что обновлять. */
export function UpdateBadge() {
    const [s, act] = useUpdate();
    if (!s || !["available", "downloading", "ready"].includes(s.status)) return null;
    return (
        <button className={"upd-badge " + s.status} onClick={act} disabled={s.status === "downloading"} title="Обновление Sherpa">
            {s.status === "available" && <>⬇ Обновление {s.version}</>}
            {s.status === "downloading" && <>⏳ {s.progress ?? 0}%</>}
            {s.status === "ready" && <>⟳ Перезапустить и обновить</>}
        </button>
    );
}

const UPDATE_TEXT: Record<UpdateState["status"], string> = {
    disabled: "обновления работают в установленной версии",
    idle: "",
    checking: "проверяю…",
    none: "у тебя последняя версия",
    available: "есть новая версия",
    downloading: "скачиваю…",
    ready: "скачано — перезапусти, чтобы установить",
    error: "не удалось проверить",
};

export function AppPanel() {
    const [s, act] = useUpdate();
    const [prefs, setPrefs] = useState<AppPrefs>();
    const [terms, setTerms] = useState(false);
    const [dir, setDir] = useState<string>();
    useEffect(() => {
        desktop?.app.prefs().then(setPrefs);
        desktop?.app.info().then((i) => setDir(i.userData));
    }, []);
    if (!desktop || !s) return null;
    return (
        <>
            <div className="panel-title">
                <span>Приложение</span>
                <small>версия {s.current}</small>
            </div>
            <div className="row">
                <button className={s.status === "available" || s.status === "ready" ? "primary" : ""} onClick={act} disabled={s.status === "checking" || s.status === "downloading" || s.status === "disabled"}>
                    {s.status === "available" ? `⬇ Скачать ${s.version}` : s.status === "ready" ? "⟳ Перезапустить и обновить" : s.status === "downloading" ? `⏳ ${s.progress ?? 0}%` : "Проверить обновления"}
                </button>
                <span className="hint">
                    {UPDATE_TEXT[s.status]}
                    {s.status === "error" && s.error ? `: ${s.error}` : ""}
                </span>
            </div>
            <p className="hint">Скачиваются только изменившиеся части, приложение ставится в ту же папку, настройки и прогресс сохраняются.</p>
            {prefs && (
                <label className="check">
                    <input type="checkbox" checked={prefs.closeToTray} onChange={async (e) => setPrefs(await desktop!.app.setPrefs({ closeToTray: e.target.checked }))} /> Крестик сворачивает в трей
                    (Sherpa продолжает ловить рейды и цены)
                </label>
            )}
            {dir && (
                <p className="hint">
                    Прогресс и настройки хранятся в <code>{dir}</code> (плюс копии за 7 дней в папке backups). Обновление и переустановка их не удаляют.
                </p>
            )}
            <div className="row">
                {dir && <button onClick={() => desktop!.app.showFolder(dir)}>Открыть папку данных</button>}
                <button onClick={() => setTerms(true)}>Условия использования</button>
            </div>
            {terms && <TermsModal onClose={() => setTerms(false)} />}
        </>
    );
}

export function PricePanel() {
    const [s, setS] = useState<PriceState>();
    useEffect(() => {
        if (!desktop) return;
        desktop.price.get().then(setS);
        return desktop.price.onState(setS);
    }, []);
    if (!desktop || !s) return null;
    const set = async (patch: Partial<PriceState>) => setS(await desktop!.price.set(patch));
    return (
        <>
            <div className="panel-title">
                <span>Цена по наведению</span>
                <small>{s.enabled ? (s.onlyWithGame && !s.gameRunning ? "ждёт запуска игры" : "работает") : "выключено"}</small>
            </div>
            <p className="hint">
                Наведи курсор на предмет в схроне или в рейде и подожди подсказку игры с названием — рядом появится карточка: цена на барахолке и у торговца, за
                клетку, что выгоднее, и для каких активных квестов он нужен. Sherpa читает название с экрана так же, как его видит запись экрана (OBS, Discord); в
                игру ничего не встраивается и не нажимается.
            </p>
            <label className="check">
                <input type="checkbox" checked={s.enabled} onChange={(e) => set({ enabled: e.target.checked })} /> Включить
            </label>
            <label className="check">
                <input type="checkbox" checked={s.auto} disabled={!s.enabled} onChange={(e) => set({ auto: e.target.checked })} /> Сама при наведении (иначе — по{" "}
                <kbd>Ctrl+Shift+P</kbd>)
            </label>
            <label className="check">
                <input type="checkbox" checked={s.onlyWithGame} disabled={!s.enabled} onChange={(e) => set({ onlyWithGame: e.target.checked })} /> Только пока
                запущена игра
            </label>
            <label className="check">
                <input type="checkbox" checked={s.debug} disabled={!s.enabled} onChange={(e) => set({ debug: e.target.checked })} /> Сохранять кадры распознавания
                (если ошибается — пришли их мне)
            </label>
            {s.debug && (
                <div className="row">
                    <button onClick={() => desktop!.price.openDebug()}>Открыть папку кадров</button>
                </div>
            )}
            {s.last && <div className="fix">Последний предмет: {s.last}</div>}
            <p className="hint">Игра должна быть в режиме «Оконный без рамки». Работает и с русской, и с английской версией игры.</p>
        </>
    );
}
