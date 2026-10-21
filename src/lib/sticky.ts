// Состояние интерфейса, которое переживает переключение вкладок и перезагрузку страницы:
// фильтры, поиск, раскрытые карточки, выбранный рейд и т.п.

import { useCallback, useState } from "react";

const memory = new Map<string, unknown>();
const PREFIX = "sherpa:ui:";

function read<T>(key: string, init: T): T {
    if (memory.has(key)) return memory.get(key) as T;
    try {
        const raw = localStorage.getItem(PREFIX + key);
        if (raw != null) {
            const v = JSON.parse(raw) as T;
            memory.set(key, v);
            return v;
        }
    } catch {
        /* приватный режим или повреждённые данные */
    }
    return init;
}

export function useSticky<T>(key: string, init: T): [T, (v: T | ((prev: T) => T)) => void] {
    const [value, setValue] = useState<T>(() => read(key, init));
    const set = useCallback(
        (v: T | ((prev: T) => T)) => {
            setValue((prev) => {
                const next = typeof v === "function" ? (v as (p: T) => T)(prev) : v;
                memory.set(key, next);
                try {
                    localStorage.setItem(PREFIX + key, JSON.stringify(next));
                } catch {
                    /* не сохранится между перезагрузками — не страшно */
                }
                return next;
            });
        },
        [key],
    );
    return [value, set];
}
