import { memo, useEffect, useMemo, useRef, useState } from "react";
import L from "leaflet";
import type { Bundle, GameMap, LayerExtent, MapLayer, Vec3 } from "../types";
import { makeCRS, onLevel, toBounds, toLatLng } from "../lib/crs";
import { objectivePoints } from "../lib/quests";
import type { RaidPlan } from "../lib/raids";
import type { PlayerFix } from "../lib/navigator";
import { labelRu } from "../lib/labels-ru";
import { loadSvgText } from "../lib/useNavGrid";
import { layerRu, type DetailRoute } from "../lib/navdetail";
import { heatmapFor } from "../lib/heatmap";
import { classifyHazards, type HazardClasses } from "../lib/hazards";
import { loadStyled, styledBounds, styledUrl, type StyledEntry } from "../lib/styledMaps";
import { safeColor } from "../lib/store";

export interface MapFocus {
    position: Vec3;
    seq: number;
    /** Карта, на которой выбрана точка: на другой карте фокус не применяется. */
    mapKey: string;
}

interface Props {
    bundle: Bundle;
    map: GameMap;
    plan: RaidPlan;
    /** null — показывать все рейды одинаково. */
    selectedRaid: number | null;
    doneStops: Set<string>;
    targetStop?: string;
    otherTasks: Bundle["tasks"];
    showOther: boolean;
    showExtracts: boolean;
    showLabels: boolean;
    showHazards: boolean;
    /** Выходы, доступные в этом рейде (по названию). undefined — все. */
    availableExtracts?: Set<string>;
    fix?: PlayerFix;
    /** Путь игрок → цель (навигатор). */
    guide?: [number, number][];
    /** Подробный маршрут к цели: подход, участки по этажам, входы и лестницы. */
    detail?: DetailRoute;
    follow: boolean;
    onTakeTask: (taskId: string) => void;
    focus?: MapFocus;
    onSelectStop: (stopId: string, raid: number) => void;
}


export default memo(MapView);

function MapView(props: Props) {
    const { map: gameMap } = props;
    const display = gameMap.display;
    const el = useRef<HTMLDivElement>(null);
    const lmap = useRef<L.Map>();
    const layers = useRef<Record<"labels" | "hazards" | "extracts" | "other" | "raids" | "player", L.LayerGroup>>({} as never);
    const detailLayer = useRef<L.LayerGroup>();
    /** Счётчик пересоздания карты: слои перерисовываются после смены локации/подложки. */
    const [mapGen, setMapGen] = useState(0);
    const base = useRef<{ svg?: SVGSVGElement; image?: L.ImageOverlay; url?: string; tile?: L.TileLayer; styled?: L.ImageOverlay; styledIdx?: Record<string, StyledEntry> }>({});
    const [level, setLevel] = useState(-1);
    const [svgReady, setSvgReady] = useState(0);
    const [zoom, setZoom] = useState(0);
    const hasBoth = !!display.svgPath && !!display.tilePath;
    const [style, setStyle] = useState<"svg" | "tile">("svg");
    const useTile = !!display.tilePath && (!display.svgPath || style === "tile");

    const levels: MapLayer[] = useMemo(() => display.layers.filter((l) => l.svgLayer || l.tilePath), [display]);
    const activeExtents: LayerExtent[] | undefined = useMemo(() => {
        if (level >= 0) return levels[level]?.extents;
        return display.heightRange ? [{ height: display.heightRange }] : undefined;
    }, [level, display, levels]);

    // ---- создание карты ----
    useEffect(() => {
        if (!el.current) return;
        const bounds = toBounds(display.bounds);
        const m = L.map(el.current, {
            crs: makeCRS(display),
            zoomSnap: 0.25,
            wheelPxPerZoomLevel: 120,
            attributionControl: false,
            minZoom: display.minZoom,
            maxZoom: Math.max(7, display.maxZoom),
            maxBounds: bounds.pad(0.4),
        });
        lmap.current = m;
        setLevel(-1);

        let cancelled = false;
        if (useTile && display.tilePath) {
            const addTiles = () => {
                base.current.tile = L.tileLayer(display.tilePath!, {
                    tileSize: display.tileSize ?? 256,
                    bounds,
                    maxNativeZoom: display.maxZoom,
                    maxZoom: Math.max(7, display.maxZoom),
                }).addTo(m);
                base.current.tile.bringToBack();
            };
            if (display.svgPath) addTiles(); // «спутник» у карт со схемой
            else
                // у карт без SVG — своя перекрашенная схема, если она готова, иначе тайлы как есть
                loadStyled().then((idx) => {
                    if (cancelled) return;
                    const e = idx[display.tilePath!];
                    if (!e) return addTiles();
                    base.current.styledIdx = idx;
                    base.current.styled = L.imageOverlay(styledUrl(e), styledBounds(display, e), { className: "base-map styled", interactive: false }).addTo(m);
                    base.current.styled.bringToBack();
                    setSvgReady((n) => n + 1);
                });
        }
        if (display.svgPath && !useTile) {
            loadSvgText(display.svgPath)
                .then((text) => {
                    if (cancelled) return;
                    // SVG показываем картинкой (<img>), а не встроенным в страницу: встроенный SVG
                    // Chrome не всегда перерисовывает после зума/ресайза, и метки «уезжают» с подложки.
                    const svg = new DOMParser().parseFromString(text, "image/svg+xml").documentElement as unknown as SVGSVGElement;
                    svg.removeAttribute("width");
                    svg.removeAttribute("height");
                    svg.setAttribute("preserveAspectRatio", "none");
                    base.current.svg = svg;
                    base.current.image = L.imageOverlay("", display.svgBounds ? toBounds(display.svgBounds) : bounds, { className: "base-map", interactive: false }).addTo(m);
                    base.current.image.bringToBack();
                    setSvgReady((n) => n + 1);
                })
                .catch(() => !cancelled && el.current?.classList.add("no-basemap"));
        }
        m.fitBounds(bounds);
        for (const k of ["hazards", "labels", "extracts", "other", "raids", "player"] as const) layers.current[k] = L.layerGroup().addTo(m);
        detailLayer.current = L.layerGroup().addTo(m);
        setMapGen((n) => n + 1);
        const onZoom = () => setZoom(m.getZoom());
        m.on("zoomend", onZoom);
        onZoom();

        return () => {
            cancelled = true;
            if (base.current.url) URL.revokeObjectURL(base.current.url);
            m.stop();
            m.off();
            m.remove();
            lmap.current = undefined;
            base.current = {};
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [gameMap.key, useTile]);

    // ---- этажи ----
    useEffect(() => {
        const { svg, tile, image, styled, styledIdx } = base.current;
        const layer = level >= 0 ? levels[level] : undefined;
        if (svg && image) {
            const levelIds = new Set(display.layers.map((l) => l.svgLayer).filter(Boolean));
            for (const g of Array.from(svg.children)) {
                if (g.nodeName !== "g" || !g.id) continue;
                const el = g as SVGGElement;
                if (g.id === display.svgLayer) el.style.opacity = layer && !layer.show ? "0.2" : "";
                else if (levelIds.has(g.id)) el.style.display = layer?.svgLayer === g.id ? "" : "none";
            }
            const url = URL.createObjectURL(new Blob([new XMLSerializer().serializeToString(svg)], { type: "image/svg+xml" }));
            image.setUrl(url);
            if (base.current.url) URL.revokeObjectURL(base.current.url);
            base.current.url = url;
        }
        if (tile && display.tilePath) tile.setUrl(layer?.tilePath ?? display.tilePath);
        if (styled && styledIdx) {
            const e = styledIdx[layer?.tilePath ?? display.tilePath!];
            if (e) {
                styled.setUrl(styledUrl(e));
                styled.setBounds(styledBounds(display, e));
            }
        }
    }, [level, svgReady, display, levels, useTile]);

    // ---- метки: отдельные слои, каждый перерисовывается только при своих изменениях ----
    const lvl = (p: Vec3, top?: number, bottom?: number) => (onLevel(p, activeExtents, top, bottom) ? "" : " off-level");
    const onSelectRef = useRef(props.onSelectStop);
    onSelectRef.current = props.onSelectStop;
    const onTakeRef = useRef(props.onTakeTask);
    onTakeRef.current = props.onTakeTask;

    // подписи районов: зависят только от «ступени» зума
    const sizes = useMemo(() => [...new Set(display.labels.map((l) => l.size))].sort((a, b) => b - a), [display]);
    const labelMin = sizes[Math.min(Math.max(0, Math.floor(zoom - display.minZoom - 0.5)), sizes.length - 1)] ?? 0;
    useEffect(() => {
        const g = layers.current.labels;
        if (!g) return;
        g.clearLayers();
        if (!props.showLabels) return;
        // крупные подписи первыми: при наложении остаются они
        for (const l of [...display.labels].sort((a, b) => b.size - a.size)) {
            if (l.size < labelMin) continue;
            L.marker(toLatLng(l), {
                icon: L.divIcon({
                    className: "map-label" + (l.size >= 60 ? " big" : ""),
                    html: `<span style="transform: rotate(${Number(l.rotation) || 0}deg)">${escapeHtml(labelRu(l.text))}</span>`,
                    iconSize: [0, 0],
                }),
                interactive: false,
                keyboard: false,
            }).addTo(g);
        }
        requestAnimationFrame(declutterLabels);
    }, [props.showLabels, labelMin, display, mapGen]);

    /** Прячет подписи, которые налезают на уже показанные (порядок — по важности). */
    function declutterLabels() {
        const g = layers.current.labels;
        if (!g) return;
        const kept: DOMRect[] = [];
        g.eachLayer((mk) => {
            const span = (mk as L.Marker).getElement()?.firstElementChild as HTMLElement | null;
            if (!span) return;
            span.style.visibility = "";
            const r = span.getBoundingClientRect();
            const hit = kept.some((k) => r.left < k.right + 4 && r.right > k.left - 4 && r.top < k.bottom + 2 && r.bottom > k.top - 2);
            if (hit) span.style.visibility = "hidden";
            else kept.push(r);
        });
    }
    useEffect(() => {
        const m = lmap.current;
        if (!m) return;
        const h = () => requestAnimationFrame(declutterLabels);
        m.on("zoomend", h);
        return () => {
            m.off("zoomend", h);
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [mapGen]);

    // опасные зоны: килбоксы (мины, края карты) — чёткими блоками; зоны внутри карты — тепловой картой
    // классы зон помнят, к какой карте относятся: иначе сразу после переключения зоны прошлой
    // карты успевали нарисоваться (и закэшироваться) в координатах новой
    const [hzState, setHzState] = useState<{ map: GameMap; classes: HazardClasses } | null>(null);
    const hzClasses = hzState?.map === gameMap ? hzState.classes : null;
    useEffect(() => {
        let cancelled = false;
        (gameMap.display.svgPath ? loadSvgText(gameMap.display.svgPath) : Promise.resolve(null))
            .then((text) => classifyHazards(gameMap, text))
            .then((r) => !cancelled && setHzState({ map: gameMap, classes: r }))
            .catch(() => !cancelled && setHzState({ map: gameMap, classes: { killbox: gameMap.hazards.filter((h) => h.outline), heat: [] } }));
        return () => {
            cancelled = true;
        };
    }, [gameMap]);
    useEffect(() => {
        const g = layers.current.hazards;
        if (!g) return;
        g.clearLayers();
        if (!hzClasses) return;
        if (!props.showHazards) return;
        const ll = (o: [number, number][]) => o.map(([x, z]) => toLatLng({ x, z }));
        // тепло: снайперские зоны внутри карты, обстрел, стационарное оружие
        const heat = heatmapFor(gameMap, hzClasses.heat);
        if (heat) L.imageOverlay(heat.url, heat.bounds, { className: "heatmap", interactive: false }).addTo(g);
        // невидимые контуры для подсказок над теплом
        const tipZone = (outline: [number, number][], text: string) =>
            L.polygon(ll(outline), { stroke: false, fillOpacity: 0, className: "heat-hit" }).bindTooltip(text, { sticky: true }).addTo(g);
        for (const a of gameMap.artillery) if (a.outline) tipZone(a.outline, "Зона миномётного обстрела (во время обстрела — укрыться)");
        for (const h of hzClasses.heat) tipZone(h.outline!, "Работают снайперы-дикие: простреливается, проходить быстро");
        // килбоксы — чёткие блоки, маршрут через них не идёт
        for (const h of hzClasses.killbox) {
            const mine = h.type === "minefield";
            L.polygon(ll(h.outline!), { className: mine ? "minefield" : "killbox", weight: 2 })
                .bindTooltip(mine ? "Минное поле — не заходить" : "Килбокс: простреливается снайперами, проход закрыт", { sticky: true })
                .addTo(g);
        }
        ensureHatch(lmap.current);
        for (const s of gameMap.stationary) {
            L.marker(toLatLng(s.position), {
                icon: L.divIcon({ className: "stationary " + s.type + lvl(s.position), html: s.type === "ags" ? "АГС" : "У", iconSize: [0, 0] }),
                keyboard: false,
            })
                .bindTooltip(s.type === "ags" ? "АГС-30 — станковый гранатомёт" : escapeHtml(s.name || "НСВ Утёс") + " — крупнокалиберный пулемёт", { direction: "top" })
                .addTo(g);
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [props.showHazards, gameMap, hzClasses, activeExtents, mapGen]);

    // выходы и переходы
    const sel = props.selectedRaid;
    const chosenExtract = sel !== null ? props.plan.raids[sel]?.extract?.name : undefined;
    useEffect(() => {
        const g = layers.current.extracts;
        if (!g) return;
        g.clearLayers();
        if (!props.showExtracts) return;
        for (const e of gameMap.extracts) {
            if (e.faction === "scav") continue;
            const chosen = chosenExtract === e.name;
            const off = props.availableExtracts && !props.availableExtracts.has(e.name);
            const cond = e.paid ? " · платный" : e.needsSwitch ? " · нужен рубильник" : "";
            L.marker(toLatLng(e.position), {
                icon: L.divIcon({
                    className: "extract" + (e.faction === "shared" ? " shared" : "") + (chosen ? " chosen" : "") + (off ? " unavailable" : "") + lvl(e.position),
                    html: chosen ? "EXIT" : "▲",
                    iconSize: chosen ? [40, 18] : [18, 18],
                }),
                keyboard: false,
                zIndexOffset: chosen ? 900 : 0,
            })
                .bindTooltip(`Выход: ${escapeHtml(e.name)}${e.faction === "shared" ? " (общий)" : ""}${cond}${off ? " — недоступен в этом рейде" : ""}`, { direction: "top" })
                .addTo(g);
        }
        for (const t of gameMap.transits) {
            L.marker(toLatLng(t.position), {
                icon: L.divIcon({ className: "transit" + lvl(t.position), html: "⇄", iconSize: [18, 18] }),
                keyboard: false,
            })
                .bindTooltip(escapeHtml(t.name), { direction: "top" })
                .addTo(g);
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [props.showExtracts, props.availableExtracts, chosenExtract, gameMap, activeExtents, mapGen]);

    // невзятые квесты
    useEffect(() => {
        const g = layers.current.other;
        if (!g) return;
        g.clearLayers();
        if (!props.showOther) return;
        for (const task of props.otherTasks) {
            for (const o of task.objectives) {
                for (const pt of objectivePoints(o, gameMap.key)) {
                    const popup = document.createElement("div");
                    popup.className = "popup";
                    const b = document.createElement("b");
                    b.textContent = task.name;
                    const d = document.createElement("div");
                    d.className = "muted";
                    d.textContent = o.text;
                    const btn = document.createElement("button");
                    btn.textContent = "Взять квест";
                    btn.onclick = () => onTakeRef.current(task.id);
                    popup.append(b, d, btn);
                    L.circleMarker(toLatLng(pt.position), {
                        radius: pt.kind === "item" ? 3.5 : 5,
                        className: "other-point" + lvl(pt.position, pt.top, pt.bottom),
                    })
                        .bindPopup(popup)
                        .addTo(g);
                }
            }
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [props.showOther, props.otherTasks, gameMap.key, activeExtents, mapGen]);

    // рейды: неактивные — бледно, выбранный — ярко
    const faintRoutes = !!props.detail;
    useEffect(() => {
        const g = layers.current.raids;
        if (!g) return;
        g.clearLayers();
        const raidOf = (i: number) => props.plan.raids[i];
        const order = props.plan.raids.map((r) => r.index).sort((a, b) => (a === sel ? 1 : b === sel ? -1 : 0));
        for (const ri of order) {
            const raid = raidOf(ri);
            const dim = sel !== null && ri !== sel ? " dim" : "";
            const faint = faintRoutes ? " faint" : "";
            const color = raid.color;
            // все места одной цели — одна группа: пунктир от основной метки к каждому запасному месту
            // и общая подсветка при наведении на любую из меток
            const groups = new Map<string, (L.Marker | L.Polyline)[]>();
            const join = (id: string, l: L.Marker | L.Polyline) => groups.set(id, [...(groups.get(id) ?? []), l]);
            raid.steps.forEach((st, si) => {
                const total = st.stop.points.length;
                st.stop.points.forEach((pt, pi) => {
                    const off = lvl(pt.position, pt.top, pt.bottom);
                    if (pt.outline) {
                        L.polygon(pt.outline.map(([x, z]) => toLatLng({ x, z })), { color, weight: 1.5, fillOpacity: 0.15, className: "zone" + off + dim, interactive: false }).addTo(g);
                    }
                    if (pt.position === st.point) return;
                    // другие места, где может быть цель (точки появления предмета, запасные зоны): маршрут ведёт
                    // к ближайшему, но подойдёт любое
                    const done = props.doneStops.has(st.stop.id);
                    const link = L.polyline([toLatLng(st.point), toLatLng(pt.position)], { color, className: "alt-link" + dim + (done ? " done" : ""), interactive: false }).addTo(g);
                    join(st.stop.id, link);
                    const m = L.marker(toLatLng(pt.position), {
                        icon: L.divIcon({ className: "stop-alt" + dim + (done ? " done" : "") + off, html: `<span style="--rc:${color}">${ri + 1}.${si + 1}</span>`, iconSize: [22, 16] }),
                        zIndexOffset: dim ? -100 : 500,
                    });
                    m.bindTooltip(
                        `<b>${escapeHtml(st.stop.task.name)}</b><br>${escapeHtml(st.stop.objective.text)}<br><span class="muted">Возможное место ${pi + 1} из ${total} — маршрут ведёт к ближайшему${pt.approx ? "<br>место по карте вики, примерно ±10 м" : ""}</span>`,
                        { direction: "top", offset: [0, -8] },
                    );
                    m.on("click", () => onSelectRef.current(st.stop.id, ri));
                    m.addTo(g);
                    join(st.stop.id, m);
                });
            });
            if (raid.legs?.length) {
                const lines = raid.legs.map((leg) => leg.map(([x, z]) => toLatLng({ x, z })));
                L.polyline(lines, { color, className: "route-line real" + dim + faint, interactive: false }).addTo(g);
            } else {
                const line: L.LatLngTuple[] = [];
                if (raid.spawn) line.push(toLatLng(raid.spawn));
                raid.steps.forEach((s) => line.push(toLatLng(s.point)));
                if (raid.extract) line.push(toLatLng(raid.extract.position));
                if (line.length > 1) L.polyline(line, { color, className: "route-line" + dim + faint, interactive: false }).addTo(g);
            }
            if (raid.spawn && !dim) {
                L.marker(toLatLng(raid.spawn), { icon: L.divIcon({ className: "spawn-pin", html: "S", iconSize: [18, 18] }) })
                    .bindTooltip(raid.spawnKnown ? "Точка спавна (по скриншоту)" : "Вероятный спавн (ближайший к первой точке)")
                    .addTo(g);
            }
            raid.steps.forEach((s, i) => {
                const pt = s.stop.points.find((p) => p.position === s.point);
                const done = props.doneStops.has(s.stop.id);
                const target = props.targetStop === s.stop.id;
                const shared = s.stop.players.length > 1;
                const cls = "stop" + dim + (done ? " done" : "") + (target ? " target" : "") + (shared ? " shared" : "") + lvl(s.point, pt?.top, pt?.bottom);
                const label = `${ri + 1}.${i + 1}`; // всегда «рейд.точка» — так же, как в карточках квестов
                const who = s.stop.players.map((p) => `<i style="background:${safeColor(p.color)}"></i>`).join("");
                const places = s.stop.points.length;
                // число мест, где может быть цель, — значком на основной метке
                const many = places > 1 ? `<b class="places" style="--rc:${color}">${places}</b>` : "";
                const m = L.marker(toLatLng(s.point), {
                    icon: L.divIcon({ className: cls, html: `<span style="--rc:${color}">${done ? "✓" : label}</span>${many}<em>${who}</em>`, iconSize: [26, 26] }),
                    zIndexOffset: dim ? 0 : 1000,
                });
                const where =
                    (places > 1 ? `<br><span class="muted">Одно из ${places} возможных мест (связаны пунктиром) — ближайшее по маршруту</span>` : "") +
                    (pt?.approx ? `<br><span class="muted">место по карте вики, примерно ±10 м</span>` : "");
                m.bindTooltip(`<b>${escapeHtml(s.stop.task.name)}</b><br>${escapeHtml(s.stop.objective.text)}${where}`, { direction: "top", offset: [0, -12] });
                m.on("click", () => onSelectRef.current(s.stop.id, ri));
                m.addTo(g);
                if (places > 1) join(s.stop.id, m);
            });
            for (const list of groups.values()) {
                const hl = (on: boolean) => list.forEach((l) => l.getElement()?.classList.toggle("alt-hl", on));
                for (const l of list) if (l instanceof L.Marker) l.on("mouseover", () => hl(true)).on("mouseout", () => hl(false));
            }
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [props.plan, sel, props.doneStops, props.targetStop, faintRoutes, activeExtents, mapGen]);

    // ---- игрок ----
    // Без зависимости от зума: раньше слежение дёргало карту обратно после каждого приближения.
    useEffect(() => {
        const g = layers.current.player;
        const m = lmap.current;
        if (!g || !m) return;
        g.clearLayers();
        const fix = props.fix;
        if (!fix) return;
        if (props.guide && props.guide.length > 1) {
            L.polyline(props.guide.map(([x, z]) => toLatLng({ x, z })), { className: "guide-line", interactive: false }).addTo(g);
        }
        // Экранный угол взгляда: проецируем точку чуть впереди игрока (поворот карты от зума не зависит).
        let angle = 0;
        if (fix.forward) {
            const a = m.latLngToLayerPoint(toLatLng(fix.position));
            const b = m.latLngToLayerPoint(toLatLng({ x: fix.position.x + fix.forward.x * 10, z: fix.position.z + fix.forward.z * 10 }));
            angle = (Math.atan2(b.x - a.x, -(b.y - a.y)) * 180) / Math.PI;
        }
        L.marker(toLatLng(fix.position), {
            icon: L.divIcon({
                className: "player-pin" + (fix.forward ? "" : " no-dir"),
                html: `<div style="transform: rotate(${angle}deg)"><svg viewBox="-20 -20 40 40" width="40" height="40"><path class="cone" d="M0 0 L-11 -18 A21 21 0 0 1 11 -18 Z"/><circle r="6"/></svg></div>`,
                iconSize: [40, 40],
            }),
            zIndexOffset: 2000,
            interactive: false,
        }).addTo(g);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [props.fix, props.guide, mapGen]);

    // слежение — только когда пришла новая позиция
    useEffect(() => {
        const m = lmap.current;
        const fix = props.fix;
        if (!m || !fix || !props.follow) return;
        // позиция с другой карты (старый скриншот) — не уводим вид за край
        if (!toBounds(display.bounds).pad(0.1).contains(toLatLng(fix.position))) return;
        m.setView(toLatLng(fix.position), Math.max(m.getZoom(), display.minZoom + 2), { animate: true });
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [props.fix?.time, props.follow]);

    // ---- подробный маршрут ----
    const currentSvgLayer = level >= 0 ? levels[level]?.svgLayer ?? null : null;
    useEffect(() => {
        // при новом маршруте показываем этаж цели
        const r = props.detail;
        if (!r) return;
        const idx = r.targetLayer.svgLayer ? levels.findIndex((l) => l.svgLayer === r.targetLayer.svgLayer) : -1;
        setLevel(idx);
        // приближаемся к участку у цели (подробная часть + последние метры подхода)
        const pts = [...r.approach.slice(-2), ...r.segments.flatMap((s) => s.points)];
        const inMap = toBounds(display.bounds).pad(0.2);
        if (pts.length && lmap.current && !props.follow && pts.every(([x, z]) => inMap.contains(toLatLng({ x, z })))) {
            lmap.current.flyToBounds(L.latLngBounds(pts.map(([x, z]) => toLatLng({ x, z }))).pad(0.25), { maxZoom: display.maxZoom + 1, duration: 0.6 });
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [props.detail]);
    useEffect(() => {
        const g = detailLayer.current;
        if (!g) return;
        g.clearLayers();
        const r = props.detail;
        if (!r) return;
        const ll = (pts: [number, number][]) => pts.map(([x, z]) => toLatLng({ x, z }));
        if (r.approach.length > 1) L.polyline(ll(r.approach), { className: "detail-line" + (currentSvgLayer ? " other" : ""), interactive: false }).addTo(g);
        for (const sg of r.segments) {
            const here = sg.svgLayer === currentSvgLayer;
            L.polyline(ll(sg.points), { className: "detail-line" + (here ? "" : " other"), interactive: false })
                .bindTooltip(escapeHtml(layerRu(sg.layerName)), { sticky: true })
                .addTo(g);
        }
        for (const e of r.events) {
            const isStair = e.kind === "up" || e.kind === "down";
            const html = e.kind === "door-in" ? "ВХОД" : e.kind === "door-out" ? "ВЫХОД" : `${e.kind === "up" ? "▲" : "▼"} ${layerRu(e.toLayerName ?? "")}`;
            L.marker(toLatLng(e), {
                icon: L.divIcon({ className: "detail-ev" + (isStair ? " stair" : " door"), html, iconSize: [0, 0] }),
                zIndexOffset: 1500,
            })
                .bindTooltip(isStair ? `Лестница: ${escapeHtml(layerRu(e.layerName))} → ${escapeHtml(layerRu(e.toLayerName ?? ""))}` : html === "ВХОД" ? "Вход в здание" : "Выход на улицу")
                .addTo(g);
        }
    }, [props.detail, currentSvgLayer, gameMap.key, useTile]);

    // ---- фокус ----
    // только по новому выбору (seq) и только на своей карте: раньше смена карты (и её зума)
    // повторно запускала перелёт к точке прошлой карты — на новой там пусто
    const focusSeq = useRef(0);
    useEffect(() => {
        const f = props.focus;
        if (!f || !lmap.current || f.seq === focusSeq.current || f.mapKey !== gameMap.key) return;
        focusSeq.current = f.seq;
        lmap.current.flyTo(toLatLng(f.position), Math.max(lmap.current.getZoom(), display.maxZoom - 1), { duration: 0.6 });
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [props.focus, gameMap.key]);

    return (
        <div className="map-wrap">
            <div ref={el} className="leaflet-host" key={gameMap.key + style} />
            {levels.length > 0 && (
                <div className="levels">
                    <button className={level === -1 ? "on" : ""} onClick={() => setLevel(-1)}>
                        Основной
                    </button>
                    {levels.map((l, i) => (
                        <button key={l.name} className={level === i ? "on" : ""} onClick={() => setLevel(i)}>
                            {LEVEL_RU[l.name] ?? l.name}
                        </button>
                    ))}
                </div>
            )}
            {hasBoth && (
                <div className="styles">
                    <button className={style === "svg" ? "on" : ""} onClick={() => setStyle("svg")}>Схема</button>
                    <button className={style === "tile" ? "on" : ""} onClick={() => setStyle("tile")}>Спутник</button>
                </div>
            )}
            <div className="map-credit">
                Карта: {display.author ? <a href={display.authorLink} target="_blank" rel="noreferrer">{display.author}</a> : "tarkov.dev"} · данные tarkov.dev
            </div>
        </div>
    );
}

/** Штриховка минных полей: узор в SVG-слое Leaflet (один раз на карту). */
function ensureHatch(m: L.Map | undefined) {
    const svg = m?.getPanes().overlayPane.querySelector("svg");
    if (!svg || svg.querySelector("#sherpa-hatch")) return;
    const NS = "http://www.w3.org/2000/svg";
    const defs = svg.querySelector("defs") ?? svg.insertBefore(document.createElementNS(NS, "defs"), svg.firstChild);
    const p = document.createElementNS(NS, "pattern");
    p.setAttribute("id", "sherpa-hatch");
    p.setAttribute("patternUnits", "userSpaceOnUse");
    p.setAttribute("width", "8");
    p.setAttribute("height", "8");
    p.setAttribute("patternTransform", "rotate(45)");
    const bg = document.createElementNS(NS, "rect");
    bg.setAttribute("width", "8");
    bg.setAttribute("height", "8");
    bg.setAttribute("fill", "rgba(255,60,40,0.18)");
    const line = document.createElementNS(NS, "rect");
    line.setAttribute("width", "3");
    line.setAttribute("height", "8");
    line.setAttribute("fill", "rgba(255,60,40,0.7)");
    p.append(bg, line);
    defs.appendChild(p);
}

function escapeHtml(s: string) {
    return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

const LEVEL_RU: Record<string, string> = {
    "2nd Floor": "2 этаж",
    "3rd Floor": "3 этаж",
    "4th Floor": "4 этаж",
    "5th Floor": "5 этаж",
    Underground: "Подвал",
    Tunnels: "Тоннели",
    Bunkers: "Бункеры",
    Garage: "Гараж",
    "Second Level": "2 уровень",
    Technical: "Техэтаж",
    Infirmary: "Лазарет",
    Helipad: "Вертолётная",
    "Gym/Canteen": "Спортзал/Столовая",
    "Accommodation (lower)": "Каюты (низ)",
    "Accommodation (mid)": "Каюты (сред.)",
    "Accommodation (upper)": "Каюты (верх)",
    "Officers' Deck": "Палуба офицеров",
    "Stairs (blocked)": "Лестница (закрыта)",
    Bridge: "Мостик",
    "Bridge Roof": "Крыша мостика",
    "Control Room": "Пункт управления",
    "Engine Room": "Машинное отделение",
    "Engine Room (upper)": "Машинное (верх)",
    "Fuel Pumps (lower)": "Топливные насосы (низ)",
    "Fuel Pumps": "Топливные насосы",
    "Storage/Security": "Склад/Охрана",
};
