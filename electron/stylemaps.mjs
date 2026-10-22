// Перекраска растровых карт (Лаборатория, Лабиринт, Ледокол) в стиль векторных схем tarkov.dev.
//
// У этих карт нет SVG — только фотореалистичные тайлы, и рядом с остальными картами они выглядят
// чужими. Здесь тайлы склеиваются в одну картинку и переводятся в палитру схем: сланцевый пол,
// тёмно-синие предметы, тёмный контур помещений. Результат — webp + индекс с привязкой к сетке тайлов,
// приложение кладёт его на карту как обычную подложку. Делается один раз при обновлении данных.

import { BrowserWindow } from "electron";
import fs from "node:fs/promises";
import path from "node:path";

const MAX_PX = 4400; // сторона итоговой картинки
const SCAN_TILES = 8; // сетка 8×8 на малом зуме — чтобы найти, где на тайлах карта
const PARALLEL = 16;

/**
 * @param {{ dataDir: string, outDir: string, seedDir?: string, fetch: typeof fetch, log?: (m: string) => void, force?: boolean }} o
 * seedDir — готовые схемы из комплекта приложения: если тайлы те же, схема просто копируется.
 */
export async function styleMaps(o) {
    const log = o.log ?? (() => {});
    const bundle = JSON.parse(await fs.readFile(path.join(o.dataDir, "regular.json"), "utf8"));
    await fs.mkdir(o.outDir, { recursive: true });
    const indexFile = path.join(o.outDir, "index.json");
    let index = {};
    try {
        index = JSON.parse(await fs.readFile(indexFile, "utf8"));
    } catch {
        /* первый раз */
    }

    let seed = {};
    if (o.seedDir) seed = JSON.parse(await fs.readFile(path.join(o.seedDir, "index.json"), "utf8").catch(() => "{}"));

    const win = new BrowserWindow({ show: false, width: 64, height: 64, webPreferences: { offscreen: true, backgroundThrottling: false } });
    await win.loadURL("about:blank");
    await win.webContents.executeJavaScript(`window.stylize = ${stylizeInPage.toString()}; true`);
    try {
        for (const m of bundle.maps) {
            const d = m.display;
            if (d.svgPath || !d.tilePath) continue; // у карты есть векторная схема
            const jobs = [{ name: "main", tpl: d.tilePath }, ...d.layers.filter((l) => l.tilePath).map((l, i) => ({ name: `l${i}`, tpl: l.tilePath }))];
            for (const job of jobs) {
                const file = `${m.key}-${job.name}.webp`;
                if (!o.force && index[job.tpl]?.file === `maps/styled/${file}` && (await exists(path.join(o.outDir, file)))) continue;
                if (!o.force && seed[job.tpl]) {
                    const buf = await fs.readFile(path.join(o.seedDir, path.basename(seed[job.tpl].file))).catch(() => null);
                    if (buf) {
                        await fs.writeFile(path.join(o.outDir, file), buf);
                        index[job.tpl] = { ...seed[job.tpl], file: `maps/styled/${file}` };
                        await fs.writeFile(indexFile, JSON.stringify(index, null, 1));
                        continue;
                    }
                }
                try {
                    const meta = await styleOne(win, o.fetch, job.tpl, d.tileSize ?? 256, d.minZoom ?? 1, d.maxZoom ?? 5);
                    if (!meta) {
                        log(`  ${m.name} / ${job.name}: тайлов нет`);
                        continue;
                    }
                    await fs.writeFile(path.join(o.outDir, file), Buffer.from(meta.webp, "base64"));
                    index[job.tpl] = { file: `maps/styled/${file}`, z: meta.z, x0: meta.x0, y0: meta.y0, nx: meta.nx, ny: meta.ny, ts: d.tileSize ?? 256 };
                    await fs.writeFile(indexFile, JSON.stringify(index, null, 1));
                    log(`  схема ${m.name}${job.name === "main" ? "" : ` (${d.layers.find((l) => l.tilePath === job.tpl)?.name})`}: ${meta.w}×${meta.h}`);
                } catch (e) {
                    log(`  ${m.name} / ${job.name}: ${e.message}`);
                }
            }
        }
    } finally {
        win.destroy();
    }
    return index;
}

const exists = (p) => fs.access(p).then(() => true, () => false);

async function getTile(fetchFn, tpl, z, x, y) {
    const url = tpl.replace("{z}", z).replace("{x}", x).replace("{y}", y);
    // обрывы соединения — повторяем; 404 — тайла просто нет
    for (let attempt = 0; attempt < 4; attempt++) {
        try {
            const r = await fetchFn(url);
            if (r.status === 404 || r.status === 403) return null;
            if (r.ok) return Buffer.from(await r.arrayBuffer()).toString("base64");
        } catch {
            /* сеть */
        }
        await new Promise((res) => setTimeout(res, 600 * (attempt + 1)));
    }
    throw new Error("не удалось скачать тайлы");
}

async function inBatches(items, fn) {
    const out = [];
    for (let i = 0; i < items.length; i += PARALLEL) out.push(...(await Promise.all(items.slice(i, i + PARALLEL).map(fn))));
    return out;
}

async function styleOne(win, fetchFn, tpl, ts, minZoom, maxZoom) {
    // 1. где карта: малый зум, все тайлы, непрозрачные
    const zs = Math.max(minZoom, Math.min(maxZoom, Math.round(Math.log2(SCAN_TILES))));
    const n = 2 ** zs;
    const cells = [];
    for (let x = 0; x < n; x++) for (let y = 0; y < n; y++) cells.push([x, y]);
    const scan = await inBatches(cells, async ([x, y]) => ({ x, y, b64: await getTile(fetchFn, tpl, zs, x, y) }));
    const present = scan.filter((t) => t.b64);
    if (!present.length) return null;
    const filled = await win.webContents.executeJavaScript(`(async () => {
        const tiles = ${JSON.stringify(present)};
        const out = [];
        for (const t of tiles) {
            const im = new Image(); im.src = "data:image/png;base64," + t.b64; await im.decode();
            const c = new OffscreenCanvas(im.width, im.height); const g = c.getContext("2d"); g.drawImage(im, 0, 0);
            const a = g.getImageData(0, 0, im.width, im.height).data; let k = 0;
            for (let i = 3; i < a.length; i += 16) if (a[i] > 40) k++;
            if (k > 4) out.push([t.x, t.y]);
        }
        return out;
    })()`);
    if (!filled.length) return null;
    const bx0 = Math.min(...filled.map((t) => t[0])), bx1 = Math.max(...filled.map((t) => t[0]));
    const by0 = Math.min(...filled.map((t) => t[1])), by1 = Math.max(...filled.map((t) => t[1]));
    // 2. самый подробный зум, при котором картинка не больше MAX_PX
    let z = maxZoom;
    while (z > zs && Math.max(bx1 - bx0 + 1, by1 - by0 + 1) * 2 ** (z - zs) * ts > MAX_PX) z--;
    const k = 2 ** (z - zs);
    const x0 = bx0 * k, y0 = by0 * k, nx = (bx1 - bx0 + 1) * k, ny = (by1 - by0 + 1) * k;
    // 3. тайлы этого зума — на холст по частям
    await win.webContents.executeJavaScript(`(() => {
        window.cv = new OffscreenCanvas(${nx * ts}, ${ny * ts});
        window.cg = window.cv.getContext("2d", { willReadFrequently: true });
        return true;
    })()`);
    const want = [];
    for (let x = x0; x < x0 + nx; x++) for (let y = y0; y < y0 + ny; y++) want.push([x, y]);
    for (let i = 0; i < want.length; i += 48) {
        const part = await inBatches(want.slice(i, i + 48), async ([x, y]) => ({ x, y, b64: await getTile(fetchFn, tpl, z, x, y) }));
        const got = part.filter((t) => t.b64);
        if (!got.length) continue;
        await win.webContents.executeJavaScript(`(async () => {
            for (const t of ${JSON.stringify(got)}) {
                const im = new Image(); im.src = "data:image/png;base64," + t.b64; await im.decode();
                window.cg.drawImage(im, (t.x - ${x0}) * ${ts}, (t.y - ${y0}) * ${ts});
            }
            return true;
        })()`);
    }
    // 4. перекраска и сжатие
    const res = await win.webContents.executeJavaScript(`(async () => {
        window.stylize(window.cv);
        const blob = await window.cv.convertToBlob({ type: "image/webp", quality: 0.9 });
        const buf = new Uint8Array(await blob.arrayBuffer());
        let s = ""; for (let i = 0; i < buf.length; i += 0x8000) s += String.fromCharCode.apply(null, buf.subarray(i, i + 0x8000));
        const w = window.cv.width, h = window.cv.height;
        window.cv = window.cg = null;
        return { webp: btoa(s), w, h };
    })()`);
    return { ...res, z, x0, y0, nx, ny };
}

/**
 * Работает в странице: перекрашивает холст на месте.
 * Пол — сланцевый с мягкими оттенками (так видно комнаты и материалы), предметы и тени темнее
 * окружения — тёмно-синие, яркие детали — светлые, край помещений — тёмный контур.
 */
function stylizeInPage(cv) {
    const W = cv.width, H = cv.height, N = W * H;
    const g = cv.getContext("2d", { willReadFrequently: true });
    const img = g.getImageData(0, 0, W, H);
    const d = img.data;
    const A = new Uint8Array(N);
    const L = new Float32Array(N);
    for (let p = 0, i = 0; p < N; p++, i += 4) {
        A[p] = d[i + 3] > 40 ? 1 : 0;
        L[p] = (0.3 * d[i] + 0.59 * d[i + 1] + 0.11 * d[i + 2]) / 255;
    }
    // размытие по маске (два прохода скользящего среднего)
    function blur(f, mask, w, h, r) {
        const t = new Float32Array(w * h), o = new Float32Array(w * h);
        for (let y = 0; y < h; y++) {
            let s = 0, n = 0;
            for (let x = -r; x < w; x++) {
                const a = x + r;
                if (a < w && mask[y * w + a]) (s += f[y * w + a]), n++;
                const b = x - r - 1;
                if (b >= 0 && mask[y * w + b]) (s -= f[y * w + b]), n--;
                if (x >= 0) t[y * w + x] = n ? s / n : 0;
            }
        }
        for (let x = 0; x < w; x++) {
            let s = 0, n = 0;
            for (let y = -r; y < h; y++) {
                const a = y + r;
                if (a < h && mask[a * w + x]) (s += t[a * w + x]), n++;
                const b = y - r - 1;
                if (b >= 0 && mask[b * w + x]) (s -= t[b * w + x]), n--;
                if (y >= 0) o[y * w + x] = n ? s / n : 0;
            }
        }
        return o;
    }
    const Ls = blur(L, A, W, H, 2);
    // широкие размытия — на уменьшенной в 4 раза копии
    const S = 4, w4 = Math.ceil(W / S), h4 = Math.ceil(H / S);
    const L4 = new Float32Array(w4 * h4), A4 = new Uint8Array(w4 * h4);
    {
        const cnt = new Uint16Array(w4 * h4);
        for (let y = 0; y < H; y++)
            for (let x = 0; x < W; x++) {
                const p = y * W + x;
                if (!A[p]) continue;
                const q = ((y / S) | 0) * w4 + ((x / S) | 0);
                L4[q] += L[p];
                cnt[q]++;
            }
        for (let q = 0; q < w4 * h4; q++) if (cnt[q]) (L4[q] /= cnt[q]), (A4[q] = 1);
    }
    const Lb4 = blur(L4, A4, w4, h4, 4);
    const Lw4 = blur(L4, A4, w4, h4, 6);
    const sample = (f, x, y) => {
        const fx = Math.min(w4 - 1, Math.max(0, x / S - 0.5)), fy = Math.min(h4 - 1, Math.max(0, y / S - 0.5));
        const x1 = fx | 0, y1 = fy | 0, x2 = Math.min(w4 - 1, x1 + 1), y2 = Math.min(h4 - 1, y1 + 1);
        const tx = fx - x1, ty = fy - y1;
        return (f[y1 * w4 + x1] * (1 - tx) + f[y1 * w4 + x2] * tx) * (1 - ty) + (f[y2 * w4 + x1] * (1 - tx) + f[y2 * w4 + x2] * tx) * ty;
    };
    const hex = (h) => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];
    const NAVY = hex("#1d2633"), PALE = hex("#c3c4c9"), WALL = hex("#12161d"), LO = hex("#555a68"), HI = hex("#8c919d");
    // контур: точка пола рядом с пустотой
    const R = Math.max(1, Math.round(Math.max(W, H) / 1400));
    for (let y = 0; y < H; y++)
        for (let x = 0; x < W; x++) {
            const p = y * W + x, i = p * 4;
            if (!A[p]) {
                d[i + 3] = 0;
                continue;
            }
            let edge = false;
            for (let dy = -R; dy <= R && !edge; dy++)
                for (let dx = -R; dx <= R; dx++) {
                    const yy = y + dy, xx = x + dx;
                    if (yy < 0 || yy >= H || xx < 0 || xx >= W || !A[yy * W + xx]) {
                        edge = true;
                        break;
                    }
                }
            let col;
            if (edge) col = WALL;
            else {
                const lb = sample(Lb4, x, y);
                if (Ls[p] < lb - 0.12 || Ls[p] < 0.13) col = NAVY;
                // светлыми — только детали ярче окружения: светлый пол целиком остаётся ровным
                else if (Ls[p] > 0.55 && Ls[p] > lb + 0.18) col = PALE;
                else {
                    const v = Math.min(1, Math.max(0, (L[p] * 0.4 + sample(Lw4, x, y) * 0.6 - 0.22) / 0.45));
                    col = [LO[0] + (HI[0] - LO[0]) * v, LO[1] + (HI[1] - LO[1]) * v, LO[2] + (HI[2] - LO[2]) * v];
                }
            }
            d[i] = col[0];
            d[i + 1] = col[1];
            d[i + 2] = col[2];
            d[i + 3] = 255;
        }
    g.putImageData(img, 0, 0);
}
