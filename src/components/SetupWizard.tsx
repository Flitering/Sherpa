import { useState } from "react";
import type { GameMode } from "../types";
import type { AppState } from "../lib/store";
import { newPlayer } from "../lib/store";
import type { NavLink } from "./NavigatorTab";
import type { LogState } from "../lib/gamelogs";
import { fsSupported } from "../lib/navigator";
import { desktop } from "../lib/desktop";
import TermsModal from "./TermsModal";

interface Props {
    state: AppState;
    setState: (fn: (s: AppState) => AppState) => void;
    shots: NavLink;
    logs: NavLink;
    connect: (which: "shots" | "logs") => void;
    log?: LogState;
    lastShot?: string;
    onSyncHistory: () => void;
    historyProgress?: string;
    syncNote?: string;
    screenshotKey: string;
    overlayOpen: boolean;
    onClose: () => void;
}

const STEPS = ["Начало", "Группа", "Скриншоты", "Логи игры", desktop ? "Виджет поверх игры" : "Окно поверх игры", "Готово"];

const copy = (t: string) => navigator.clipboard?.writeText(t).catch(() => {});

/** Мастер первой настройки: что подключить, зачем и как проверить. */
export default function SetupWizard(p: Props) {
    const [step, setStep] = useState(0);
    const [terms, setTerms] = useState(false);
    const [notif, setNotif] = useState(typeof Notification !== "undefined" ? Notification.permission : "denied");
    const supported = !!desktop || fsSupported();
    const me = p.state.players.find((x) => x.id === p.state.activePlayer) ?? p.state.players[0];

    const next = () => setStep((s) => Math.min(STEPS.length - 1, s + 1));
    const prev = () => setStep((s) => Math.max(0, s - 1));

    return (
        <div className="modal-back">
            <div className="modal wizard">
                <div className="wiz-head">
                    <b>Первая настройка</b>
                    <div className="wiz-steps">
                        {STEPS.map((t, i) => (
                            <button key={t} className={"wiz-dot" + (i === step ? " on" : i < step ? " done" : "")} onClick={() => setStep(i)} title={t}>
                                {i < step ? "✓" : i + 1}
                            </button>
                        ))}
                    </div>
                    <button className="link" onClick={p.onClose}>
                        закрыть
                    </button>
                </div>

                <div className="wiz-body">
                    <h2>{STEPS[step]}</h2>

                    {step === 0 && (
                        <>
                            <p>Sherpa ведёт тебя по квестам: делит цели на рейды, строит путь по улицам и через двери, а в рейде показывает стрелку к следующей цели.</p>
                            <p>Настройка займёт пару минут. Каждый шаг можно пропустить и вернуться позже — кнопка «⚙ Настройка» вверху.</p>
                            <div className="wiz-note">
                                <b>Безопасно для аккаунта.</b> Приложение не читает память игры, не встраивается в неё и не нажимает клавиши. Оно только читает файлы, которые
                                игра сама пишет на диск: скриншоты и логи.
                            </div>
                            <p className="hint">
                                Sherpa — неофициальный бесплатный проект, не связанный с Battlestate Games. Продолжая, ты принимаешь{" "}
                                <button className="link" onClick={() => setTerms(true)}>
                                    условия использования
                                </button>
                                .
                            </p>
                            {terms && <TermsModal onClose={() => setTerms(false)} />}
                            {!supported && <div className="wiz-warn">Этот браузер не умеет следить за папками. Установи приложение Sherpa для Windows — в нём навигатор работает в любом случае.</div>}
                        </>
                    )}

                    {step === 1 && (
                        <>
                            <p>Кто идёт в рейд? Отметь себя — к этому игроку будут применяться логи и скриншоты с этого компьютера.</p>
                            {p.state.players.map((pl, i) => (
                                <div className="player" key={pl.id}>
                                    <label className="me">
                                        <input type="radio" name="wiz-me" checked={p.state.activePlayer === pl.id} onChange={() => p.setState((s) => ({ ...s, activePlayer: pl.id }))} />
                                        это я
                                    </label>
                                    <span style={{ color: pl.color, fontWeight: 800 }}>{i + 1}</span>
                                    <input
                                        className="pname"
                                        value={pl.name}
                                        onChange={(e) => p.setState((s) => ({ ...s, players: s.players.map((x) => (x.id === pl.id ? { ...x, name: e.target.value } : x)) }))}
                                    />
                                    <label>
                                        ур.
                                        <input
                                            type="number"
                                            min={1}
                                            max={79}
                                            value={pl.level}
                                            onChange={(e) =>
                                                p.setState((s) => ({ ...s, players: s.players.map((x) => (x.id === pl.id ? { ...x, level: Number(e.target.value) || 1 } : x)) }))
                                            }
                                        />
                                    </label>
                                </div>
                            ))}
                            <div className="row">
                                <button onClick={() => p.setState((s) => ({ ...s, players: [...s.players, newPlayer(`Игрок ${s.players.length + 1}`, s.players.length)] }))}>+ Игрок</button>
                            </div>
                            <p>Режим игры:</p>
                            <div className="seg">
                                {(["regular", "pve"] as GameMode[]).map((m) => (
                                    <button key={m} className={p.state.mode === m ? "on" : ""} onClick={() => p.setState((s) => ({ ...s, mode: m }))}>
                                        {m === "regular" ? "PvP" : "PvE"}
                                    </button>
                                ))}
                            </div>
                        </>
                    )}

                    {step === 2 && (
                        <>
                            <p>
                                <b>Как приложение узнаёт, где ты.</b> Само оно экран не снимает. Когда ты в рейде нажимаешь клавишу скриншота, игра сохраняет картинку и записывает в
                                имя файла твои координаты и направление взгляда. Sherpa читает только имя нового файла.
                            </p>
                            <ol className="wiz-list">
                                <li>
                                    В игре проверь клавишу: <i>Настройки → Управление → «Скриншот»</i>. Подойдёт любая — Sherpa следит за новыми файлами, а не за клавиатурой.
                                    <label className="field">
                                        Твоя клавиша (для подсказок)
                                        <input value={p.state.screenshotKey ?? ""} placeholder="Print Screen" onChange={(e) => p.setState((s) => ({ ...s, screenshotKey: e.target.value }))} />
                                    </label>
                                </li>
                                {desktop ? (
                                    <li>Папка скриншотов находится сама. Если ниже «не найдено» — сделай один скриншот в игре или выбери папку вручную.</li>
                                ) : (
                                <>
                                <li>
                                    Нажми кнопку ниже и выбери папку
                                    <code className="copy" onClick={() => copy("%USERPROFILE%\\Documents\\Escape from Tarkov\\Screenshots")} title="Скопировать">
                                        Документы\Escape from Tarkov\Screenshots
                                    </code>
                                    — путь можно вставить в адресную строку окна выбора. Если папки нет — сделай один скриншот в игре, она появится.
                                </li>
                                <li>Браузер спросит разрешение на просмотр файлов — разреши. Доступ только на чтение и только к этой папке.</li>
                                </>
                                )}
                            </ol>
                            <LinkRow label="Папка скриншотов" link={p.shots} onConnect={() => p.connect("shots")} />
                            {p.shots.status === "on" && (
                                <div className="wiz-note">
                                    Проверка: зайди в игру и нажми {p.screenshotKey}. {p.lastShot ? <b>Получено: {p.lastShot}</b> : "Пока новых скриншотов нет."}
                                </div>
                            )}
                        </>
                    )}

                    {step === 3 && (
                        <>
                            <p>
                                <b>Логи игры</b> нужны, чтобы Sherpa сама: узнавала карту и начало рейда (и предлагала открыть навигатор), отмечала взятые и сданные квесты, понимала PvP
                                или PvE.
                            </p>
                            {desktop ? (
                                <p className="hint">Папка логов находится сама по месту установки игры (лаунчер BSG или Steam). Если не нашлась — выбери папку Logs вручную.</p>
                            ) : (
                            <ol className="wiz-list">
                                <li>
                                    Выбери папку <b>Logs</b> в папке установки игры. Обычно:
                                    <code className="copy" onClick={() => copy("C:\\Battlestate Games\\Escape from Tarkov\\Logs")} title="Скопировать">
                                        C:\Battlestate Games\Escape from Tarkov\Logs
                                    </code>
                                    (если игра стоит на другом диске — путь тот же, только буква диска другая).
                                </li>
                                <li>Разреши браузеру просмотр этой папки.</li>
                            </ol>
                            )}
                            <LinkRow label="Папка логов" link={p.logs} onConnect={() => p.connect("logs")} />
                            {p.logs.status === "on" && (
                                <>
                                    <div className="wiz-note">
                                        {p.log?.logFile ? (
                                            <>
                                                Найдена сессия игры <b>{p.log.logFile}</b>
                                                {p.log.sessionMode && <> · режим {p.log.sessionMode === "pve" ? "PvE" : "PvP"}</>}
                                                {p.log.mapNameId && <> · последняя карта {p.log.mapNameId}</>}
                                            </>
                                        ) : (
                                            "Сессий игры пока не найдено — запусти игру, логи появятся."
                                        )}
                                    </div>
                                    <button className="primary" onClick={p.onSyncHistory} disabled={!!p.historyProgress}>
                                        {p.historyProgress ?? `⟳ Загрузить прогресс квестов из всех логов (игрок «${me.name}»)`}
                                    </button>
                                    {p.syncNote && <div className="sync-note">{p.syncNote}</div>}
                                </>
                            )}
                        </>
                    )}

                    {step === 4 && desktop && (
                        <>
                            <p>В рейде навигатор с миникартой показывается в прозрачном виджете поверх игры. Двигай его за верхнюю полосу, размер меняй за края.</p>
                            <ol className="wiz-list">
                                <li>
                                    В игре включи <i>Настройки → Графика → Режим экрана: «Оконный без рамки»</i>. В полноэкранном режиме окна поверх игры не видны.
                                </li>
                                <li>Когда начнётся рейд, виджет откроется сам и предложит маршрут — выбери рейд прямо в нём.</li>
                                <li>
                                    Горячие клавиши: <kbd>Ctrl+Shift+N</kbd> показать/скрыть, <kbd>Ctrl+Shift+L</kbd> пропускать клики в игру, <kbd>Ctrl+Shift+D</kbd> цель выполнена,{" "}
                                    <kbd>Ctrl+Shift+S</kbd> пропустить.
                                </li>
                            </ol>
                            <label className="check">
                                <input type="checkbox" checked={p.state.autoOverlay !== false} onChange={(e) => p.setState((s) => ({ ...s, autoOverlay: e.target.checked }))} /> Открывать
                                виджет при начале рейда
                            </label>
                            <div className="row">
                                <button onClick={() => (p.overlayOpen ? desktop!.overlay.close() : desktop!.overlay.open())}>{p.overlayOpen ? "Скрыть виджет" : "Показать виджет"}</button>
                            </div>
                        </>
                    )}

                    {step === 4 && !desktop && (
                        <>
                            <p>В рейде навигатор показывается в маленьком окне поверх всех окон — его можно двигать и менять размер.</p>
                            <ol className="wiz-list">
                                <li>
                                    В игре включи <i>Настройки → Графика → Режим экрана: «Оконный без рамки»</i>. В полноэкранном режиме окна поверх игры не видны (можно вынести
                                    окно на второй монитор).
                                </li>
                                <li>
                                    Разреши уведомления — Sherpa позовёт, когда начнётся рейд, даже если браузер свёрнут.
                                    <div className="row">
                                        <button
                                            className={notif === "granted" ? "" : "primary"}
                                            disabled={notif === "granted" || typeof Notification === "undefined"}
                                            onClick={async () => setNotif(await Notification.requestPermission())}
                                        >
                                            {notif === "granted" ? "✓ Уведомления разрешены" : "Разрешить уведомления"}
                                        </button>
                                    </div>
                                </li>
                                <li>
                                    Когда начнётся рейд, появится предложение «Открыть навигатор» — одно нажатие откроет окно. Начать вручную можно на вкладке «Рейды» → «В рейд».
                                </li>
                            </ol>
                        </>
                    )}

                    {step === 5 && (
                        <>
                            <ul className="wiz-check">
                                <li className={p.state.players.length ? "ok" : ""}>Группа: {p.state.players.map((x) => x.name).join(", ")}</li>
                                <li className={p.shots.status === "on" ? "ok" : ""}>Скриншоты: {p.shots.status === "on" ? "подключены" : "не подключены — не будет позиции на карте"}</li>
                                <li className={p.logs.status === "on" ? "ok" : ""}>Логи: {p.logs.status === "on" ? "подключены" : "не подключены — карту и квесты придётся отмечать вручную"}</li>
                                {desktop ? (
                                    <li className={p.state.autoOverlay !== false ? "ok" : ""}>Виджет: {p.state.autoOverlay !== false ? "откроется сам при начале рейда" : "открывается вручную (Ctrl+Shift+N)"}</li>
                                ) : (
                                    <li className={notif === "granted" ? "ok" : ""}>Уведомления: {notif === "granted" ? "разрешены" : "выключены"}</li>
                                )}
                            </ul>
                            <p>Дальше: вкладка «Квесты» — отметь взятые квесты (или распознай их со скриншота списка заданий), затем «Рейды».</p>
                        </>
                    )}
                </div>

                <div className="wiz-foot">
                    <button onClick={prev} disabled={step === 0}>
                        ← Назад
                    </button>
                    {step < STEPS.length - 1 ? (
                        <button className="primary" onClick={next}>
                            {step === 0 ? "Начать" : "Дальше →"}
                        </button>
                    ) : (
                        <button className="primary" onClick={p.onClose}>
                            Готово
                        </button>
                    )}
                </div>
            </div>
        </div>
    );
}

function LinkRow({ label, link, onConnect }: { label: string; link: NavLink; onConnect: () => void }) {
    return (
        <div className={"link-row " + link.status}>
            <span className="led" />
            <div className="link-info">
                <b>{label}</b>: {link.status === "on" ? `подключена (${link.name})` : link.status === "need-permission" ? "нужно разрешение" : link.status === "error" ? "ошибка" : "не подключена"}
                {link.error && <div className="warn">{link.error}</div>}
            </div>
            {desktop ? (
                <button className={link.status === "on" ? "" : "primary"} onClick={onConnect}>
                    {link.status === "on" ? "Изменить…" : "Выбрать папку"}
                </button>
            ) : (
                link.status !== "on" && (
                    <button className="primary" onClick={onConnect}>
                        {link.status === "need-permission" ? "Разрешить" : "Выбрать папку"}
                    </button>
                )
            )}
        </div>
    );
}
