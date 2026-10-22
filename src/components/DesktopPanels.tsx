import { useEffect, useState } from "react";
import { desktop, type AppPrefs, type Hotkey, type HotkeyId, type PriceState, type UpdateState } from "../lib/desktop";
import TermsModal from "./TermsModal";

/** Горячие клавиши (с отметкой, какие заняты другой программой) — общие для всех вкладок. */
export function useHotkeys(): Hotkey[] {
    const [list, setList] = useState<Hotkey[]>([]);
    useEffect(() => {
        if (!desktop) return;
        desktop.hotkeys.get().then(setList);
        return desktop.hotkeys.onState(setList);
    }, []);
    return list;
}

const HOTKEY_LABELS: Record<HotkeyId, string> = {
    overlay: "показать / скрыть виджет",
    clickThrough: "пропускать клики сквозь виджет в игру (и обратно)",
    done: "цель выполнена — к следующей",
    skip: "пропустить цель",
    price: "цена предмета под курсором",
};

/** Клавиша по физическому положению (e.code), чтобы русская раскладка не мешала → имя в сочетании Electron. */
const CODE_KEYS: Record<string, string> = {
    Space: "Space", Tab: "Tab", Backspace: "Backspace", Delete: "Delete", Insert: "Insert", Home: "Home", End: "End", PageUp: "PageUp", PageDown: "PageDown",
    ArrowUp: "Up", ArrowDown: "Down", ArrowLeft: "Left", ArrowRight: "Right", Minus: "-", Equal: "=", BracketLeft: "[", BracketRight: "]",
    Semicolon: ";", Quote: "'", Comma: ",", Period: ".", Slash: "/", Backslash: "\\", Backquote: "`",
};
function keyOf(code: string): string | null {
    let m: RegExpExecArray | null;
    if ((m = /^Key([A-Z])$/.exec(code))) return m[1];
    if ((m = /^Digit(\d)$/.exec(code))) return m[1];
    if ((m = /^Numpad(\d)$/.exec(code))) return "Num" + m[1];
    if (/^F([1-9]|1\d|2[0-4])$/.test(code)) return code;
    return CODE_KEYS[code] ?? null;
}
function acceleratorOf(e: KeyboardEvent): string | null {
    const key = keyOf(e.code);
    if (!key) return null;
    const mods = [e.ctrlKey && "Ctrl", e.altKey && "Alt", e.shiftKey && "Shift", e.metaKey && "Super"].filter(Boolean) as string[];
    return [...mods, key].join("+");
}

/** Таблица горячих клавиш с переназначением: «Изменить» → нажать сочетание. */
export function HotkeysEditor() {
    const list = useHotkeys();
    const [rec, setRec] = useState<HotkeyId | null>(null);
    const [err, setErr] = useState("");

    useEffect(() => {
        if (!rec || !desktop) return;
        const stop = () => {
            setRec(null);
            desktop!.hotkeys.pause(false);
        };
        const onKey = async (e: KeyboardEvent) => {
            e.preventDefault();
            e.stopPropagation();
            if (e.code === "Escape" && !e.ctrlKey && !e.altKey && !e.shiftKey) return stop();
            const acc = acceleratorOf(e);
            if (!acc) return; // пока нажаты только модификаторы
            if (!acc.includes("+") && !/^F\d+$/.test(acc)) {
                setErr("Нужен модификатор (Ctrl, Alt, Shift) — одиночные клавиши нужны в игре. Без него можно только F1–F24.");
                return;
            }
            setRec(null);
            try {
                await desktop!.hotkeys.set(rec, acc);
                setErr("");
            } catch (x) {
                setErr(String((x as Error).message).replace(/^.*Error: /, ""));
                desktop!.hotkeys.pause(false);
            }
        };
        window.addEventListener("keydown", onKey, true);
        window.addEventListener("blur", stop);
        return () => {
            window.removeEventListener("keydown", onKey, true);
            window.removeEventListener("blur", stop);
        };
    }, [rec]);

    const start = (id: HotkeyId) => {
        setErr("");
        setRec(id);
        desktop!.hotkeys.pause(true);
    };
    const set = async (id: HotkeyId, acc: string | null) => {
        try {
            await desktop!.hotkeys.set(id, acc);
            setErr("");
        } catch (x) {
            setErr(String((x as Error).message).replace(/^.*Error: /, ""));
        }
    };

    return (
        <>
            <table className="hotkeys">
                <tbody>
                    {list.map((h) => (
                        <tr key={h.id}>
                            <td>{rec === h.id ? <kbd className="rec">нажми сочетание…</kbd> : <kbd>{h.accelerator || "выкл."}</kbd>}</td>
                            <td>
                                {HOTKEY_LABELS[h.id]}
                                {h.busy && <span className="warn"> — занято другой программой</span>}
                            </td>
                            <td className="hk-act">
                                {rec === h.id ? (
                                    <button className="link" onClick={() => (setRec(null), desktop!.hotkeys.pause(false))}>
                                        отмена
                                    </button>
                                ) : (
                                    <>
                                        <button className="link" disabled={!!rec} onClick={() => start(h.id)}>
                                            изменить
                                        </button>
                                        {h.accelerator !== h.default && (
                                            <button className="link" disabled={!!rec} onClick={() => set(h.id, null)} title={`Вернуть ${h.default}`}>
                                                сбросить
                                            </button>
                                        )}
                                        {h.accelerator && (
                                            <button className="link" disabled={!!rec} onClick={() => set(h.id, "")}>
                                                выключить
                                            </button>
                                        )}
                                    </>
                                )}
                            </td>
                        </tr>
                    ))}
                </tbody>
            </table>
            {rec && <p className="hint">Нажми новое сочетание. Esc — отмена.</p>}
            {err && <p className="hint warn">{err}</p>}
            {list.some((h) => h.busy) && (
                <p className="hint warn">Часть сочетаний заняла другая программа (оверлей видеокарты, Discord и т. п.) — эти нажатия уходят в игру. Назначь другое сочетание.</p>
            )}
        </>
    );
}

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
                    {s.error ? ` (${s.error})` : ""}
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
    const scanKey = useHotkeys().find((h) => h.id === "price");
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
                клетку, что выгоднее, и для каких активных квестов он нужен. Sherpa читает название с экрана так же, как его видит запись экрана (OBS, Discord), и
                сверяет картинку предмета в клетке с картинками tarkov.dev (их скачивает один раз); в игру ничего не встраивается и не нажимается.
            </p>
            <label className="check">
                <input type="checkbox" checked={s.enabled} onChange={(e) => set({ enabled: e.target.checked })} /> Включить
            </label>
            <label className="check">
                <input type="checkbox" checked={s.auto} disabled={!s.enabled} onChange={(e) => set({ auto: e.target.checked })} /> Сама при наведении (иначе — по{" "}
                <kbd>{scanKey?.accelerator || "горячей клавише"}</kbd>)
            </label>
            {scanKey?.busy && (
                <p className="hint warn">
                    <kbd>{scanKey.accelerator}</kbd> занято другой программой (оверлей видеокарты, Discord и т. п.) — нажатия уходят в игру. Назначь другое
                    сочетание на вкладке «Навигатор».
                </p>
            )}
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
