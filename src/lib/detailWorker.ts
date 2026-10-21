// Web Worker: многоэтажный поиск пути по подробной сетке (комнаты, проёмы, лестницы).

export {};

interface LayerIn {
    cost: Uint8Array;
    stairs: Uint8Array;
    indoor?: Uint8Array;
}

const DX = [1, -1, 0, 0, 1, 1, -1, -1];
const DY = [0, 0, 1, -1, 1, -1, 1, -1];
const DL = [1, 1, 1, 1, Math.SQRT2, Math.SQRT2, Math.SQRT2, Math.SQRT2];
/** Подъём/спуск на этаж, м пути. */
const STAIR_COST = 6;

let hk = new Float64Array(4096);
let hv = new Int32Array(4096);
let hn = 0;
function push(k: number, v: number) {
    if (hn >= hk.length) {
        const k2 = new Float64Array(hk.length * 2);
        k2.set(hk);
        hk = k2;
        const v2 = new Int32Array(hv.length * 2);
        v2.set(hv);
        hv = v2;
    }
    let i = hn++;
    while (i > 0) {
        const p = (i - 1) >> 1;
        if (hk[p] <= k) break;
        hk[i] = hk[p];
        hv[i] = hv[p];
        i = p;
    }
    hk[i] = k;
    hv[i] = v;
}
function pop(): number {
    const top = hv[0];
    const k = hk[--hn];
    const v = hv[hn];
    let i = 0;
    for (;;) {
        let c = 2 * i + 1;
        if (c >= hn) break;
        if (c + 1 < hn && hk[c + 1] < hk[c]) c++;
        if (hk[c] >= k) break;
        hk[i] = hk[c];
        hv[i] = hv[c];
        i = c;
    }
    hk[i] = k;
    hv[i] = v;
    return top;
}

function snap(cost: Uint8Array, W: number, H: number, c: number, maxR: number): number {
    if (cost[c]) return c;
    const cx = c % W;
    const cy = (c / W) | 0;
    for (let r = 1; r <= maxR; r++) {
        for (let dy = -r; dy <= r; dy++) {
            for (let dx = -r; dx <= r; dx++) {
                if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
                const x = cx + dx;
                const y = cy + dy;
                if (x < 0 || y < 0 || x >= W || y >= H) continue;
                if (cost[y * W + x]) return y * W + x;
            }
        }
    }
    return -1;
}

function visible(cost: Uint8Array, W: number, a: number, b: number, limit: number): boolean {
    let x0 = a % W, y0 = (a / W) | 0;
    const x1 = b % W, y1 = (b / W) | 0;
    const dx = Math.abs(x1 - x0), dy = -Math.abs(y1 - y0);
    const sx = x0 < x1 ? 1 : -1, sy = y0 < y1 ? 1 : -1;
    let err = dx + dy;
    for (;;) {
        const c = cost[y0 * W + x0];
        if (!c || c > limit) return false;
        if (x0 === x1 && y0 === y1) return true;
        const e2 = 2 * err;
        if (e2 >= dy) {
            err += dy;
            x0 += sx;
        }
        if (e2 <= dx) {
            err += dx;
            y0 += sy;
        }
    }
}

function smooth(cost: Uint8Array, W: number, path: number[], keep: Set<number>): number[] {
    if (path.length < 3) return path;
    const out = [path[0]];
    let i = 0;
    while (i < path.length - 1) {
        let best = i + 1;
        // прямая не может проходить по клеткам дороже своих концов (иначе срезает сквозь дома)
        const base = Math.max(cost[path[i]], 13);
        let fails = 0;
        for (let j = i + 2; j < path.length; j++) {
            // не «срезаем» отмеченные точки (вход, лестница)
            if (keep.has(path[j - 1])) break;
            const limit = Math.max(base, Math.min(cost[path[j]], cost[path[j - 1]]));
            if (visible(cost, W, path[i], path[j], limit)) {
                best = j;
                fails = 0;
            } else if (++fails > 60) break;
        }
        out.push(path[best]);
        i = best;
    }
    return out;
}

self.onmessage = (e: MessageEvent) => {
    const m = e.data as { id: number; w: number; h: number; cellMeters: number; layers: LayerIn[]; from: { l: number; c: number }; to: { l: number; c: number } };
    try {
        const { w: W, h: H, cellMeters: CELL, layers } = m;
        const N = W * H;
        const L = layers.length;
        const from = snap(layers[m.from.l].cost, W, H, m.from.c, 60);
        const to = snap(layers[m.to.l].cost, W, H, m.to.c, 60);
        if (from < 0 || to < 0) {
            (self as unknown as Worker).postMessage({ id: m.id, result: null, reason: `snap from=${from} to=${to}` });
            return;
        }
        const src = m.from.l * N + from;
        const dst = m.to.l * N + to;
        const dist = new Float32Array(L * N).fill(Infinity);
        const prev = new Int32Array(L * N).fill(-1);
        const done = new Uint8Array(L * N);
        const gx = to % W;
        const gy = (to / W) | 0;
        const hfun = (c: number) => Math.hypot((c % W) - gx, ((c / W) | 0) - gy) * CELL;
        hn = 0;
        dist[src] = 0;
        push(hfun(from), src);
        while (hn > 0) {
            const node = pop();
            if (done[node]) continue;
            done[node] = 1;
            if (node === dst) break;
            const l = (node / N) | 0;
            const c = node - l * N;
            const cost = layers[l].cost;
            const cx = c % W;
            const cy = (c / W) | 0;
            for (let k = 0; k < 8; k++) {
                const x = cx + DX[k];
                const y = cy + DY[k];
                if (x < 0 || y < 0 || x >= W || y >= H) continue;
                const n = y * W + x;
                if (!cost[n]) continue;
                if (k >= 4 && (!cost[cy * W + x] || !cost[y * W + cx])) continue;
                const nn = l * N + n;
                if (done[nn]) continue;
                const nd = dist[node] + ((cost[c] + cost[n]) / 20) * DL[k] * CELL;
                if (nd < dist[nn]) {
                    dist[nn] = nd;
                    prev[nn] = node;
                    push(nd + hfun(n), nn);
                }
            }
            // лестница: тот же символ на соседнем этаже
            if (layers[l].stairs[c]) {
                for (const l2 of [l - 1, l + 1]) {
                    if (l2 < 0 || l2 >= L) continue;
                    if (!layers[l2].stairs[c] || !layers[l2].cost[c]) continue;
                    const nn = l2 * N + c;
                    if (done[nn]) continue;
                    const nd = dist[node] + STAIR_COST;
                    if (nd < dist[nn]) {
                        dist[nn] = nd;
                        prev[nn] = node;
                        push(nd + hfun(c), nn);
                    }
                }
            }
        }
        if (!(dist[dst] < Infinity)) {
            let settledCount = 0;
            for (let i = 0; i < done.length; i++) settledCount += done[i];
            (self as unknown as Worker).postMessage({ id: m.id, result: null, reason: `unreachable, settled=${settledCount}, L=${L}, from=${m.from.l}:${from}, to=${m.to.l}:${to}` });
            return;
        }
        const nodes: number[] = [];
        for (let x = dst; x !== -1; x = prev[x]) nodes.push(x);
        nodes.reverse();

        // сегменты по этажам + события
        type Ev = { kind: "door-in" | "door-out" | "up" | "down"; cell: number; layer: number; toLayer?: number };
        const events: Ev[] = [];
        const segments: { layer: number; cells: number[] }[] = [];
        let cur: { layer: number; cells: number[] } | null = null;
        for (let i = 0; i < nodes.length; i++) {
            const l = (nodes[i] / N) | 0;
            const c = nodes[i] - l * N;
            if (!cur || cur.layer !== l) {
                if (cur) {
                    const pl = cur.layer;
                    events.push({ kind: l > pl ? "up" : "down", cell: c, layer: pl, toLayer: l });
                }
                cur = { layer: l, cells: [] };
                segments.push(cur);
            }
            if (i > 0) {
                const pl = (nodes[i - 1] / N) | 0;
                const pc = nodes[i - 1] - pl * N;
                const ind = layers[l].indoor;
                if (pl === l && ind && ind[pc] !== ind[c]) events.push({ kind: ind[c] ? "door-in" : "door-out", cell: c, layer: l });
            }
            cur.cells.push(c);
        }
        const keep = new Set(events.map((ev) => ev.cell));
        const out = segments.map((s) => ({ layer: s.layer, cells: Int32Array.from(smooth(layers[s.layer].cost, W, s.cells, keep)) }));
        // настоящая длина: шаги по клеткам + условные метры на каждую лестницу
        let meters = 0;
        for (let i = 1; i < nodes.length; i++) {
            const la = (nodes[i - 1] / N) | 0;
            const lb = (nodes[i] / N) | 0;
            const a = nodes[i - 1] - la * N;
            const b = nodes[i] - lb * N;
            meters += la !== lb ? 4 : Math.hypot((a % W) - (b % W), ((a / W) | 0) - ((b / W) | 0)) * CELL;
        }
        (self as unknown as Worker).postMessage({ id: m.id, result: { segments: out, events, length: meters, from, to } });
    } catch (err) {
        (self as unknown as Worker).postMessage({ id: m.id, error: String(err) });
    }
};
