// Локальное хранение прогресса в браузере (localStorage), импорт и экспорт в файл.

import { useEffect, useState } from "react";
import type { GameMode, Player } from "../types";
import type { RaidSettings } from "./raids";

export interface AppState {
    version: 1;
    mode: GameMode;
    mapKey: string;
    activePlayer: string;
    players: Player[];
    raidSettings?: RaidSettings;
    /** Время последнего применённого события лога по режимам (regular/pve). */
    logSync?: Record<string, number>;
    /** Автоматически отмечать квесты по логам игры. */
    autoSync?: boolean;
    /** Разведцентр 3 уровня: комиссия барахолки −30%. */
    intelCenter?: boolean;
}

const KEY = "sherpa:v1";
export const PLAYER_COLORS = ["#4ccdea", "#f5af5a", "#aadd89", "#cba8ff", "#ff8a8a"];

export const newPlayer = (name: string, index: number): Player => ({
    id: Math.random().toString(36).slice(2, 10),
    name,
    color: PLAYER_COLORS[index % PLAYER_COLORS.length],
    level: 15,
    tasks: {},
    objectivesDone: {},
});

function initial(): AppState {
    const me = newPlayer("Игрок 1", 0);
    return { version: 1, mode: "regular", mapKey: "streets-of-tarkov", activePlayer: me.id, players: [me, newPlayer("Игрок 2", 1)] };
}

function load(): AppState {
    try {
        const raw = localStorage.getItem(KEY);
        if (raw) {
            const s = JSON.parse(raw) as AppState;
            if (s.version === 1 && s.players?.length) {
                // старые имена по умолчанию → «Игрок N»
                s.players = s.players.map((p, i) => (p.name === "Я" || p.name === "Друг" ? { ...p, name: `Игрок ${i + 1}` } : p));
                return s;
            }
        }
    } catch {
        /* повреждённые данные — начинаем заново */
    }
    return initial();
}

export function usePersistentState() {
    const [state, setState] = useState<AppState>(load);
    useEffect(() => {
        try {
            localStorage.setItem(KEY, JSON.stringify(state));
        } catch {
            /* приватный режим браузера — прогресс просто не сохранится */
        }
    }, [state]);
    return [state, setState] as const;
}

export function exportState(state: AppState) {
    const blob = new Blob([JSON.stringify(state, null, 2)], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `sherpa-progress-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(a.href);
}

export async function importState(file: File): Promise<AppState> {
    const s = JSON.parse(await file.text()) as AppState;
    if (s.version !== 1 || !Array.isArray(s.players)) throw new Error("Это не файл прогресса Sherpa");
    return s;
}
