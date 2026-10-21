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

/** Отступ от стен внутри зданий: в пределах CLEAR_M шаг дороже — путь идёт серединой комнат и проёмов. */
const CLEAR_M = 0.9;
const CLEAR_K = 1.5;
function clearanceFactor(cost: Uint8Array, W: number, H: number, CELL: number): Float32Array {
    const INF = 1e9;
    const d = new Float32Array(W * H);
    for (let i = 0; i < W * H; i++) d[i] = cost[i] ? INF : 0;
    const relax = (i: number, j: number, w: number) => {
        if (d[j] + w < d[i]) d[i] = d[j] + w;
    };
    for (let y = 0; y < H; y++)
        for (let x = 0; x < W; x++) {
            const i = y * W + x;
            if (!d[i]) continue;
            if (x > 0) relax(i, i - 1, 3);
            if (y > 0) {
                relax(i, i - W, 3);
                if (x > 0) relax(i, i - W - 1, 4);
                if (x < W - 1) relax(i, i - W + 1, 4);
            }
        }
    for (let y = H - 1; y >= 0; y--)
        for (let x = W - 1; x >= 0; x--) {
            const i = y * W + x;
            if (!d[i]) continue;
            if (x < W - 1) relax(i, i + 1, 3);
            if (y < H - 1) {
                relax(i, i + W, 3);
                if (x < W - 1) relax(i, i + W + 1, 4);
                if (x > 0) relax(i, i + W - 1, 4);
            }
        }
    const fct = new Float32Array(W * H);
    for (let i = 0; i < W * H; i++) {
        if (!cost[i]) continue;
        const near = Math.max(0, CLEAR_M - (d[i] / 3) * CELL) / CLEAR_M;
        fct[i] = (cost[i] / 10) * (1 + CLEAR_K * near * near);
    }
    return fct;
}

/** Дуглас–Пекер с проверкой проходимости и сохранением отмеченных точек (вход, лестница). */
function simplifyDP(cost: Uint8Array, W: number, path: number[], keepCells: Set<number>, tol: number): number[] {
    if (path.length < 3) return path;
    const keep = new Uint8Array(path.length);
    keep[0] = keep[path.length - 1] = 1;
    path.forEach((c, i) => keepCells.has(c) && (keep[i] = 1));
    const anchors = path.map((_, i) => i).filter((i) => keep[i]);
    const stack: [number, number][] = [];
    for (let k = 1; k < anchors.length; k++) stack.push([anchors[k - 1], anchors[k]]);
    while (stack.length) {
        const [i, j] = stack.pop()!;
        if (j - i < 2) continue;
        const ax = path[i] % W, ay = (path[i] / W) | 0;
        const bx = path[j] % W, by = (path[j] / W) | 0;
        const len = Math.hypot(bx - ax, by - ay) || 1;
        let worst = -1;
        let wd = 0;
        let maxCost = 0;
        for (let k = i + 1; k < j; k++) {
            const px = path[k] % W, py = (path[k] / W) | 0;
            const dd = Math.abs((bx - ax) * (ay - py) - (ax - px) * (by - ay)) / len;
            if (dd > wd) {
                wd = dd;
                worst = k;
            }
            maxCost = Math.max(maxCost, cost[path[k]]);
        }
        if (wd > tol || !visible(cost, W, path[i], path[j], Math.max(cost[path[i]], cost[path[j]], maxCost))) {
            const k = worst > 0 ? worst : (i + j) >> 1;
            keep[k] = 1;
            stack.push([i, k], [k, j]);
        }
    }
    return path.filter((_, k) => keep[k]);
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

self.onmessage = (e: MessageEvent) => {
    const m = e.data as { id: number; w: number; h: number; cellMeters: number; layers: LayerIn[]; from: { l: number; c: number }; to: { l: number; c: number } };
    try {
        const { w: W, h: H, cellMeters: CELL, layers } = m;
        const N = W * H;
        const factors = layers.map((l) => clearanceFactor(l.cost, W, H, CELL));
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
                const f = factors[l];
                const nd = dist[node] + ((f[c] + f[n]) / 2) * DL[k] * CELL;
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
        // допуск упрощения ~0.4 м: комнаты небольшие, повороты у дверей должны остаться
        const out = segments.map((s) => ({ layer: s.layer, cells: Int32Array.from(simplifyDP(layers[s.layer].cost, W, s.cells, keep, 0.4 / CELL)) }));
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
