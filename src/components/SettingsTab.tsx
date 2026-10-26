import { useEffect, useState } from "react";
import type { PlayerFix } from "../lib/navigator";
import type { LogState } from "../lib/gamelogs";
import { fsSupported } from "../lib/navigator";
import { desktop } from "../lib/desktop";
import type { Player } from "../types";
import { AppPanel, PricePanel } from "./DesktopPanels";
import type { NavLink } from "./NavigatorTab";

interface Props {
    shots: NavLink;
    logs: NavLink;
    connectShots: () => void;
    connectLogs: () => void;
    disconnect: (which: "shots" | "logs") => void;
    fix?: PlayerFix;
    log?: LogState;
    meName: string;
    autoSync: boolean;
    setAutoSync: (b: boolean) => void;
    onSyncHistory: () => void;
    syncNote?: string;
    historyProgress?: string;
    screenshotKey: string;
    setScreenshotKey: (k: string) => void;
    onDataUpdated: () => void;
    players: Player[];
    activePlayer: string;
    /** Сбросить статусы квестов и отметки целей игрока (или всех — null). */
    onResetProgress: (playerId: string | null) => void;
}

/** «log_2026.10.22_22-32-15_…» → «22.10.2026 22:32». */
function sessionDate(folder: string) {
    const m = /log_(\d{4})\.(\d{2})\.(\d{2})_(\d{2})-(\d{2})/.exec(folder);
    return m ? `${m[3]}.${m[2]}.${m[1]} ${m[4]}:${m[5]}` : folder;
}

const STATUS = { off: "не найдено", "need-permission": "нужно разрешение", on: "подключено", error: "ошибка" };

export default function SettingsTab(p: Props) {
    const filesOk = !!desktop || fsSupported();
    return (
        <div className="tab">
            {filesOk ? (
                <>
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
                </>
            ) : (
                <p className="hint">Папки игры (скриншоты и логи) в этом браузере недоступны. Установи приложение Sherpa для Windows — в нём всё работает без настроек браузера.</p>
            )}

            <ResetPanel players={p.players} activePlayer={p.activePlayer} onReset={p.onResetProgress} />

            {desktop && <PricePanel />}

            {desktop && <DataPanel onUpdated={p.onDataUpdated} />}

            <MarketKeyPanel />

            {desktop && <AppPanel />}
        </div>
    );
}

/** Сброс статусов квестов — чтобы заново загрузить их из логов или распознать со скриншота. */
function ResetPanel({ players, activePlayer, onReset }: { players: Player[]; activePlayer: string; onReset: (id: string | null) => void }) {
    const [who, setWho] = useState<string>(activePlayer);
    const [note, setNote] = useState<string>();
    const target = who === "all" ? null : players.find((x) => x.id === who) ?? null;
    const count = (target ? [target] : players).reduce((n, x) => n + Object.keys(x.tasks).length, 0);
    return (
        <>
            <div className="panel-title">
                <span>Прогресс квестов</span>
            </div>
            <p className="hint">
                Сброс снимает у игрока все отметки «активен» и «выполнен» и галочки целей. После него прогресс можно собрать заново: «Загрузить прогресс из всех логов игры»
                выше и «Распознать задания со скриншота» на вкладке «Квесты».
            </p>
            <div className="row">
                <select value={who} onChange={(e) => setWho(e.target.value)}>
                    {players.map((x) => (
                        <option key={x.id} value={x.id}>
                            {x.name}
                        </option>
                    ))}
                    {players.length > 1 && <option value="all">все игроки</option>}
                </select>
                <button
                    className="danger"
                    disabled={!count}
                    onClick={() => {
                        const name = target ? `игрока «${target.name}»` : "всех игроков";
                        if (!window.confirm(`Сбросить статусы квестов ${name}? Отметок: ${count}. Отменить сброс нельзя.`)) return;
                        onReset(target ? target.id : null);
                        setNote(`Сброшено отметок: ${count}.`);
                    }}
                >
                    Сбросить статусы квестов
                </button>
            </div>
            {note && <div className="sync-note">{note}</div>}
        </>
    );
}

/** API-ключ tarkov-market: свежий список квестов при «Обновить данные». */
function MarketKeyPanel() {
    const [info, setInfo] = useState<{ set: boolean; tail: string | null; canEncrypt: boolean; questsAt: string | null }>();
    const [value, setValue] = useState("");
    const [busy, setBusy] = useState(false);
    const [note, setNote] = useState<{ text: string; warn?: boolean }>();
    useEffect(() => {
        desktop?.tarkovMarket.info().then(setInfo);
    }, []);
    const save = async (key: string | null) => {
        setBusy(true);
        setNote(undefined);
        try {
            const r = await desktop!.tarkovMarket.setKey(key);
            setValue("");
            setInfo(await desktop!.tarkovMarket.info());
            setNote({
                text: key
                    ? `Ключ принят и сохранён. Персонажи: ${r.characters.map((c) => `${c.name} (${c.gameMode})`).join(", ") || "нет"}. Список квестов обновится при «Обновить данные».`
                    : "Ключ удалён.",
            });
        } catch (e) {
            // текст ошибки из главного процесса приходит с префиксом IPC
            setNote({ text: (e as Error).message.replace(/^Error invoking remote method '[^']+': (Error: )?/, ""), warn: true });
        } finally {
            setBusy(false);
        }
    };
    return (
        <>
            <div className="panel-title">
                <span>API tarkov-market</span>
                <small>{info?.set ? `ключ …${info.tail}` : "ключ не задан"}</small>
            </div>
            <p className="hint">
                Нужен PRO-аккаунт <a href="https://tarkov-market.com/ru/dev/api" target="_blank" rel="noreferrer">tarkov-market</a>. С ключом «Обновить данные» заодно скачивает
                свежий список квестов, которые есть в игре: удалённые квесты пропадают, новые и сюжетные главы появляются. Без ключа используется список, встроенный в
                приложение{info?.questsAt ? ` (последний скачанный — ${new Date(info.questsAt).toLocaleDateString("ru-RU")})` : ""}.
            </p>
            {desktop ? (
                <>
                    <div className="row">
                        <input
                            type="password"
                            className="grow"
                            autoComplete="off"
                            spellCheck={false}
                            placeholder={info?.set ? "новый ключ — заменит сохранённый" : "API-ключ"}
                            value={value}
                            onChange={(e) => setValue(e.target.value)}
                            onKeyDown={(e) => e.key === "Enter" && value.trim() && save(value.trim())}
                        />
                        <button className="primary" disabled={busy || !value.trim()} onClick={() => save(value.trim())}>
                            {busy ? "Проверяю…" : "Сохранить"}
                        </button>
                        {info?.set && (
                            <button disabled={busy} onClick={() => save(null)}>
                                Удалить
                            </button>
                        )}
                    </div>
                    <p className="hint">
                        Ключ хранится только на этом компьютере, зашифрованным средствами Windows, и отправляется только на api.tarkov-market.app. Он даёт доступ к прогрессу
                        твоих персонажей на сайте — не показывай его другим.
                    </p>
                    {info && !info.canEncrypt && <div className="hint warn">Windows не даёт зашифровать ключ — сохранить его не получится.</div>}
                </>
            ) : (
                <p className="hint">Ключ вводится в приложении Sherpa для Windows — в браузерной версии данные не обновляются.</p>
            )}
            {note && <div className={"sync-note" + (note.warn ? " warn" : "")}>{note.text}</div>}
        </>
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
