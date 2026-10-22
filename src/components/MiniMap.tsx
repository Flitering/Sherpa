import { useEffect, useRef, useState } from "react";
import L from "leaflet";
import type { MapDisplay } from "../types";
import { makeCRS, toBounds } from "../lib/crs";
import { loadSvgText } from "../lib/useNavGrid";
import type { HudPoint } from "../lib/hudModel";

interface Props {
    display: MapDisplay;
    mapKey: string;
    color: string;
    fix?: { x: number; y: number; z: number; heading?: number };
    points: HudPoint[];
    guide?: [number, number][];
    extract?: { x: number; z: number; name: string };
    /** Радиус обзора, м. */
    radius: number;
    /** Прозрачность подложки карты 0..1. */
    mapAlpha?: number;
}

interface Base {
    canvas: HTMLCanvasElement | null;
    toPx: (p: { x: number; z: number }) => [number, number];
    pxPerM: number;
}

const baseCache = new Map<string, Promise<Base>>();

/** Подложка карты одной картинкой ~2 px/м и перевод игровых координат в её пиксели. */
function loadBase(mapKey: string, display: MapDisplay): Promise<Base> {
    let p = baseCache.get(mapKey);
    if (p) return p;
    p = (async () => {
        const crs = makeCRS(display);
        const b = toBounds(display.svgBounds ?? display.bounds);
        const p1 = crs.latLngToPoint(b.getNorthWest(), 0);
        const p2 = crs.latLngToPoint(b.getSouthEast(), 0);
        const rect = L.bounds(p1, p2);
        const rw = rect.max!.x - rect.min!.x;
        const rh = rect.max!.y - rect.min!.y;
        const [[x1, z1], [x2, z2]] = display.svgBounds ?? display.bounds;
        const mPerProj = Math.sqrt((Math.abs(x1 - x2) * Math.abs(z1 - z2)) / (rw * rh));
        const widthM = rw * mPerProj;
        const pxPerM = Math.min(2, 3000 / Math.max(widthM, (widthM * rh) / rw));
        const w = Math.round(widthM * pxPerM);
        const h = Math.round((w * rh) / rw);
        const toPx = (q: { x: number; z: number }): [number, number] => {
            const pt = crs.latLngToPoint(L.latLng(q.z, q.x), 0);
            return [((pt.x - rect.min!.x) / rw) * w, ((pt.y - rect.min!.y) / rh) * h];
        };
        let canvas: HTMLCanvasElement | null = null;
        if (display.svgPath) {
            try {
                const text = await loadSvgText(display.svgPath);
                const doc = new DOMParser().parseFromString(text, "image/svg+xml");
                const svg = doc.documentElement;
                svg.setAttribute("width", String(w));
                svg.setAttribute("height", String(h));
                svg.setAttribute("preserveAspectRatio", "none");
                for (const g of Array.from(svg.children)) {
                    if (g.nodeName === "g" && g.id && g.id !== display.svgLayer && g.getAttribute("data-keep-with-group") !== display.svgLayer) g.remove();
                }
                const url = URL.createObjectURL(new Blob([new XMLSerializer().serializeToString(svg)], { type: "image/svg+xml" }));
                try {
                    const img = new Image();
                    img.src = url;
                    await img.decode();
                    canvas = document.createElement("canvas");
                    canvas.width = w;
                    canvas.height = h;
                    canvas.getContext("2d")!.drawImage(img, 0, 0, w, h);
                } finally {
                    URL.revokeObjectURL(url);
                }
            } catch {
                canvas = null;
            }
        }
        return { canvas, toPx, pxPerM };
    })();
    baseCache.set(mapKey, p);
    return p;
}

/** Миникарта: кусок карты вокруг игрока, «вперёд — вверх», путь и точки маршрута. */
export default function MiniMap({ display, mapKey, color, fix, points, guide, extract, radius, mapAlpha = 0.85 }: Props) {
    const ref = useRef<HTMLCanvasElement>(null);
    const [base, setBase] = useState<Base | null>(null);
    const [size, setSize] = useState({ w: 200, h: 200 });

    useEffect(() => {
        let cancelled = false;
        setBase(null);
        loadBase(mapKey, display).then((b) => !cancelled && setBase(b));
        return () => {
            cancelled = true;
        };
    }, [mapKey, display]);

    useEffect(() => {
        const el = ref.current?.parentElement;
        if (!el) return;
        const ro = new ResizeObserver(() => setSize({ w: el.clientWidth, h: el.clientHeight }));
        ro.observe(el);
        return () => ro.disconnect();
    }, []);

    useEffect(() => {
        const cv = ref.current;
        if (!cv || !base) return;
        const dpr = window.devicePixelRatio || 1;
        cv.width = Math.max(1, Math.round(size.w * dpr));
        cv.height = Math.max(1, Math.round(size.h * dpr));
        const ctx = cv.getContext("2d")!;
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        ctx.clearRect(0, 0, size.w, size.h);

        const center = fix ?? points.find((p) => p.target) ?? points[0];
        if (!center) return;
        const [cx, cy] = base.toPx(center);
        // поворот «вперёд — вверх»: угол направления взгляда на подложке
        let rot = 0;
        if (fix?.heading !== undefined) {
            const h = (fix.heading * Math.PI) / 180;
            const [fx, fy] = base.toPx({ x: center.x + Math.sin(h) * 10, z: center.z + Math.cos(h) * 10 });
            rot = -Math.atan2(fx - cx, -(fy - cy));
        }
        const R = Math.min(size.w, size.h) / 2;
        const scale = R / (radius * base.pxPerM);

        ctx.save();
        // круглое окно миникарты
        ctx.beginPath();
        ctx.arc(size.w / 2, size.h / 2, R - 1, 0, Math.PI * 2);
        ctx.clip();
        ctx.fillStyle = "rgba(8,10,8,0.55)";
        ctx.fillRect(0, 0, size.w, size.h);
        ctx.translate(size.w / 2, size.h / 2);
        ctx.rotate(rot);
        ctx.scale(scale, scale);
        ctx.translate(-cx, -cy);
        if (base.canvas) {
            ctx.globalAlpha = mapAlpha;
            ctx.imageSmoothingQuality = "high";
            ctx.drawImage(base.canvas, 0, 0);
            ctx.globalAlpha = 1;
        }
        const lw = 1 / scale;
        // путь
        if (guide && guide.length > 1) {
            ctx.strokeStyle = "#e3c96b";
            ctx.lineWidth = 4 * lw;
            ctx.lineJoin = "round";
            ctx.lineCap = "round";
            ctx.setLineDash([2 * lw, 6 * lw]);
            ctx.beginPath();
            guide.forEach(([x, z], i) => {
                const [px, py] = base.toPx({ x, z });
                if (i) ctx.lineTo(px, py);
                else ctx.moveTo(px, py);
            });
            ctx.stroke();
            ctx.setLineDash([]);
        }
        // выход
        if (extract) {
            const [ex, ey] = base.toPx(extract);
            ctx.save();
            ctx.translate(ex, ey);
            ctx.rotate(-rot);
            ctx.fillStyle = "#86a957";
            ctx.font = `800 ${11 * lw}px 'Roboto Condensed', sans-serif`;
            ctx.textAlign = "center";
            ctx.textBaseline = "middle";
            ctx.strokeStyle = "#000";
            ctx.lineWidth = 3 * lw;
            ctx.strokeText("EXIT", 0, 0);
            ctx.fillText("EXIT", 0, 0);
            ctx.restore();
        }
        // точки маршрута
        for (const p of points) {
            const [px, py] = base.toPx(p);
            ctx.save();
            ctx.translate(px, py);
            ctx.rotate(-rot);
            const r = (p.target ? 9 : 6) * lw;
            ctx.fillStyle = p.target ? color : "rgba(8,10,8,0.85)";
            ctx.strokeStyle = color;
            ctx.lineWidth = 2 * lw;
            ctx.beginPath();
            ctx.arc(0, 0, r, 0, Math.PI * 2);
            ctx.fill();
            ctx.stroke();
            if (p.target) {
                ctx.fillStyle = "#0b0b09";
                ctx.font = `800 ${8 * lw}px 'Roboto Condensed', sans-serif`;
                ctx.textAlign = "center";
                ctx.textBaseline = "middle";
                ctx.fillText(p.label, 0, 0.5 * lw);
            }
            ctx.restore();
        }
        ctx.restore();

        // игрок в центре
        ctx.save();
        ctx.translate(size.w / 2, size.h / 2);
        if (fix) {
            if (fix.heading !== undefined) {
                ctx.fillStyle = "rgba(227,201,107,0.25)";
                ctx.beginPath();
                ctx.moveTo(0, 0);
                ctx.arc(0, 0, R * 0.45, -Math.PI / 2 - 0.5, -Math.PI / 2 + 0.5);
                ctx.closePath();
                ctx.fill();
            }
            ctx.fillStyle = "#e3c96b";
            ctx.strokeStyle = "#000";
            ctx.lineWidth = 2;
            ctx.beginPath();
            ctx.moveTo(0, -9);
            ctx.lineTo(6.5, 7);
            ctx.lineTo(0, 3.5);
            ctx.lineTo(-6.5, 7);
            ctx.closePath();
            ctx.fill();
            ctx.stroke();
        }
        ctx.restore();
        // рамка и масштаб
        ctx.strokeStyle = "rgba(217,212,191,0.35)";
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.arc(size.w / 2, size.h / 2, R - 1, 0, Math.PI * 2);
        ctx.stroke();
        ctx.fillStyle = "rgba(217,212,191,0.7)";
        ctx.font = "600 10px 'Roboto Condensed', sans-serif";
        ctx.textAlign = "center";
        ctx.fillText(`${radius} м`, size.w / 2, size.h / 2 + R - 8);
    }, [base, size, fix, points, guide, extract, radius, color, mapAlpha]);

    return <canvas ref={ref} className="minimap" style={{ width: "100%", height: "100%", display: "block" }} />;
}
