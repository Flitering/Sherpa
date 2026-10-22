import type { Player } from "../types";
import { exportState, importState, newPlayer, removePlayer, type AppState } from "../lib/store";
import { desktop } from "../lib/desktop";
import DeletePlayer from "./DeletePlayer";

interface Props {
    state: AppState;
    setState: (s: AppState) => void;
}

export default function PlayersTab({ state, setState }: Props) {
    const update = (id: string, patch: Partial<Player>) =>
        setState({ ...state, players: state.players.map((p) => (p.id === id ? { ...p, ...patch } : p)) });

    return (
        <div className="tab">
            <p className="hint">Маршрут строится по активным квестам всех игроков в списке. Общие цели сливаются в одну точку.</p>
            {state.players.map((p) => (
                <div className="player" key={p.id}>
                    <label className="me" title="Этот игрок — ты: к нему применяются логи игры и скриншоты с этого компьютера">
                        <input type="radio" name="me" checked={state.activePlayer === p.id} onChange={() => setState({ ...state, activePlayer: p.id })} />
                        это я
                    </label>
                    <input type="color" value={p.color} onChange={(e) => update(p.id, { color: e.target.value })} />
                    <input className="pname" value={p.name} onChange={(e) => update(p.id, { name: e.target.value })} />
                    <label>
                        ур.
                        <input type="number" min={1} max={79} value={p.level} onChange={(e) => update(p.id, { level: Number(e.target.value) || 1 })} />
                    </label>
                    <span className="muted">
                        {Object.values(p.tasks).filter((s) => s === "active").length} акт. / {Object.values(p.tasks).filter((s) => s === "done").length} вып.
                    </span>
                    {state.players.length > 1 && <DeletePlayer name={p.name} onDelete={() => setState(removePlayer(state, p.id))} />}
                </div>
            ))}
            <div className="row">
                <button onClick={() => setState({ ...state, players: [...state.players, newPlayer(`Игрок ${state.players.length + 1}`, state.players.length)] })}>+ Игрок</button>
                <button onClick={() => exportState(state)}>Сохранить в файл</button>
                <label className="button">
                    Загрузить из файла
                    <input
                        type="file"
                        accept="application/json"
                        hidden
                        onChange={async (e) => {
                            const f = e.target.files?.[0];
                            if (!f) return;
                            try {
                                setState(await importState(f));
                            } catch (err) {
                                alert((err as Error).message);
                            }
                        }}
                    />
                </label>
            </div>
            <p className="hint">
                {desktop
                    ? "Прогресс сохраняется на этом компьютере автоматически, с резервными копиями за последние дни; обновления приложения его не трогают. Файл — чтобы перенести прогресс на другой компьютер."
                    : "Прогресс хранится в этом браузере. Файл — чтобы перенести его в другой браузер или на другой компьютер."}
            </p>
        </div>
    );
}
