import { dataUrl } from "./desktop";
import { useEffect, useState } from "react";
import type { GameMap } from "../types";
import { buildNavGrid, PathService } from "./navgrid";

const svgCache = new Map<string, Promise<string>>();

/** SVG карты (один запрос на файл за сеанс). */
export function loadSvgText(path: string): Promise<string> {
    let p = svgCache.get(path);
    if (!p) {
        p = fetch(dataUrl(path)).then((r) => {
            if (!r.ok) throw new Error(`${r.status}`);
            return r.text();
        });
        p.catch(() => svgCache.delete(path));
        svgCache.set(path, p);
    }
    return p;
}

export type NavStatus = "none" | "loading" | "ready" | "error";

/** Сетка проходимости и сервис путей для карты. Карты без SVG (только тайлы) — status "none". */
export function useNavGrid(map: GameMap | undefined) {
    const [svc, setSvc] = useState<PathService | null>(null);
    const [status, setStatus] = useState<NavStatus>("none");

    useEffect(() => {
        setSvc(null);
        if (!map?.display.svgPath) {
            setStatus("none");
            return;
        }
        setStatus("loading");
        let cancelled = false;
        let created: PathService | null = null;
        loadSvgText(map.display.svgPath)
            .then((text) => buildNavGrid(map, text))
            .then((grid) => {
                if (cancelled) return;
                created = new PathService(grid);
                setSvc(created);
                setStatus("ready");
            })
            .catch((e) => {
                console.warn("Сетка проходимости не построена:", e);
                if (!cancelled) setStatus("error");
            });
        return () => {
            cancelled = true;
            created?.dispose();
        };
    }, [map]);

    return { svc, status };
}
