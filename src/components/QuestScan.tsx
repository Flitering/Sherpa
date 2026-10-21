import { useState } from "react";
import { useSticky } from "../lib/sticky";
import type { Bundle, Player } from "../types";
import { captureScreen, latestScreenshot, matchTasks, recognize, type TaskMatch } from "../lib/ocr";
import { inferCompleted } from "../lib/progressSync";

interface Props {
    bundle: Bundle;
    players: Player[];
    activePlayer: string;
    shotsDir?: FileSystemDirectoryHandle;
    onApply: (playerId: string, taskIds: string[]) => string;
}

/** Распознавание списка заданий со скриншота: найденные — активные, их предшественники — выполнены. */
export default function QuestScan({ bundle, players, activePlayer, shotsDir, onApply }: Props) {
    const [open, setOpen] = useSticky("scan.open", false);
    const [busy, setBusy] = useState<string>();
    const [matches, setMatches] = useState<TaskMatch[]>();
    const [checked, setChecked] = useState<Set<string>>(new Set());
    const [player, setPlayer] = useState(activePlayer);
    const [note, setNote] = useState<string>();
    const [raw, setRaw] = useState("");

    const run = async (get: () => Promise<Blob | ImageBitmap | null>) => {
        setNote(undefined);
        setMatches(undefined);
        try {
            setBusy("получаю изображение…");
            const img = await get();
            if (!img) {
                setBusy(undefined);
                setNote("Изображение не найдено.");
                return;
            }
            const text = await recognize(img, (p) => setBusy(p));
            setRaw(text);
            const m = matchTasks(bundle, text);
            setMatches(m);
            setChecked(new Set(m.map((x) => x.taskId)));
            if (!m.length) setNote("Названия заданий не найдены. Сделай скриншот вкладки «Задачи» крупнее, без перекрытий.");
        } catch (e) {
            if ((e as Error).name !== "NotAllowedError") setNote("Ошибка: " + (e as Error).message);
        } finally {
            setBusy(undefined);
        }
    };

    const preview = (() => {
        if (!matches?.length) return 0;
        const p = players.find((x) => x.id === player);
        if (!p) return 0;
        const tasks = { ...p.tasks };
        for (const id of checked) tasks[id] = "active";
        return inferCompleted(bundle, tasks).added;
    })();

    if (!open) {
        return (
            <button className="wide" onClick={() => setOpen(true)}>
                📷 Распознать задания со скриншота
            </button>
        );
    }
    return (
        <section className="scan">
            <div className="panel-title">
                <span>Распознать задания</span>
                <button className="link" onClick={() => setOpen(false)}>
                    свернуть
                </button>
            </div>
            <p className="hint">
                Открой в игре список заданий (персонаж → «Задачи», режим «в процессе») и сделай снимок. Найденные квесты станут активными, а все квесты, без которых они бы не
                открылись, — выполненными.
            </p>
            <div className="row">
                <button onClick={() => run(captureScreen)} disabled={!!busy}>
                    🖥 Снимок экрана
                </button>
                {shotsDir && (
                    <button onClick={() => run(() => latestScreenshot(shotsDir))} disabled={!!busy}>
                        🖼 Последний скриншот игры
                    </button>
                )}
                <label className="button">
                    📂 Файл
                    <input type="file" accept="image/*" hidden onChange={(e) => e.target.files?.[0] && run(async () => e.target.files![0])} />
                </label>
            </div>
            <div
                className="drop"
                tabIndex={0}
                onPaste={(e) => {
                    const f = [...e.clipboardData.files].find((x) => x.type.startsWith("image/"));
                    if (f) run(async () => f);
                }}
            >
                или вставь картинку сюда (Ctrl+V)
            </div>
            {busy && <div className="hint">⏳ {busy}</div>}
            {note && <div className="hint warn">{note}</div>}
            {matches && matches.length > 0 && (
                <>
                    <div className="scan-list">
                        {matches.map((m) => (
                            <label key={m.taskId} className="check">
                                <input
                                    type="checkbox"
                                    checked={checked.has(m.taskId)}
                                    onChange={() => {
                                        const s = new Set(checked);
                                        if (s.has(m.taskId)) s.delete(m.taskId);
                                        else s.add(m.taskId);
                                        setChecked(s);
                                    }}
                                />
                                {m.name} <small className="muted">{Math.round(m.score * 100)}%</small>
                            </label>
                        ))}
                    </div>
                    <div className="row">
                        <select value={player} onChange={(e) => setPlayer(e.target.value)}>
                            {players.map((p) => (
                                <option key={p.id} value={p.id}>
                                    {p.name}
                                </option>
                            ))}
                        </select>
                        <button
                            className="primary"
                            disabled={!checked.size}
                            onClick={() => {
                                setNote(onApply(player, [...checked]));
                                setMatches(undefined);
                            }}
                        >
                            Отметить: {checked.size} активных, +{preview} выполненных
                        </button>
                    </div>
                </>
            )}
            {raw && (
                <details className="hint">
                    <summary>распознанный текст</summary>
                    <pre className="raw">{raw}</pre>
                </details>
            )}
        </section>
    );
}
