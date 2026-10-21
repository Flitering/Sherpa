// Web Worker: поиск путей по сетке проходимости (Дейкстра / A*), без блокировки интерфейса.

export {};

let W = 0;
let H = 0;
let CELL = 1;
let cost = new Uint8Array(0);
let dist = new Float64Array(0);
let prevCell = new Int32Array(0);
let settled = new Uint8Array(0);

const DX = [1, -1, 0, 0, 1, 1, -1, -1];
const DY = [0, 0, 1, -1, 1, -1, 1, -1];
const DL = [1, 1, 1, 1, Math.SQRT2, Math.SQRT2, Math.SQRT2, Math.SQRT2];

// ---- двоичная куча (ключ — Float64, значение — номер клетки) ----
let hk = new Float64Array(1024);
let hv = new Int32Array(1024);
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

/** Ближайшая проходимая клетка (точка может стоять в стене или за краем). */
function snap(c: number): number {
    if (cost[c]) return c;
    const cx = c % W;
    const cy = (c / W) | 0;
    for (let r = 1; r < 40; r++) {
        for (let dy = -r; dy <= r; dy++) {
            for (let dx = -r; dx <= r; dx++) {
                if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
                const x = cx + dx;
                const y = cy + dy;
                if (x < 0 || y < 0 || x >= W || y >= H) continue;
                const n = y * W + x;
                if (cost[n]) return n;
            }
        }
    }
    return c;
}

function stepCost(a: number, b: number, k: number) {
    return ((cost[a] + cost[b]) / 20) * DL[k] * CELL;
}

/**
 * Дейкстра (heuristic = false) или A* (к одной цели) из source.
 * Останавливается, когда все targets закрыты.
 */
function search(source: number, targets: Set<number>, goal?: number) {
    dist.fill(Infinity);
    prevCell.fill(-1);
    settled.fill(0);
    hn = 0;
    dist[source] = 0;
    const gx = goal !== undefined ? goal % W : 0;
    const gy = goal !== undefined ? (goal / W) | 0 : 0;
    const h = (c: number) => (goal === undefined ? 0 : Math.hypot((c % W) - gx, ((c / W) | 0) - gy) * CELL);
    push(h(source), source);
    let left = targets.size;
    while (hn > 0) {
        const c = pop();
        if (settled[c]) continue;
        settled[c] = 1;
        if (targets.has(c) && --left <= 0) break;
        const cx = c % W;
        const cy = (c / W) | 0;
        for (let k = 0; k < 8; k++) {
            const x = cx + DX[k];
            const y = cy + DY[k];
            if (x < 0 || y < 0 || x >= W || y >= H) continue;
            const n = y * W + x;
            if (!cost[n] || settled[n]) continue;
            // не срезаем углы сквозь стены
            if (k >= 4 && (!cost[cy * W + x] || !cost[y * W + cx])) continue;
            const nd = dist[c] + stepCost(c, n, k);
            if (nd < dist[n]) {
                dist[n] = nd;
                prevCell[n] = c;
                push(nd + h(n), n);
            }
        }
    }
}

function trace(target: number): number[] {
    const out: number[] = [];
    for (let c = target; c !== -1; c = prevCell[c]) out.push(c);
    return out.reverse();
}

/** Прямая видимость: все клетки отрезка не дороже limit. */
function visible(a: number, b: number, limit: number): boolean {
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

/** Спрямление «лесенки»: оставляем только точки поворота, не заходя на более дорогие клетки. */
function smooth(path: number[]): Int32Array {
    if (path.length < 3) return Int32Array.from(path);
    const out = [path[0]];
    let i = 0;
    while (i < path.length - 1) {
        let best = i + 1;
        let limit = Math.max(cost[path[i]], cost[path[i + 1]]);
        let fails = 0;
        for (let j = i + 2; j < path.length; j++) {
            limit = Math.max(limit, cost[path[j]]);
            if (visible(path[i], path[j], limit)) {
                best = j;
                fails = 0;
            } else if (++fails > 8) break;
        }
        out.push(path[best]);
        i = best;
    }
    return Int32Array.from(out);
}

self.onmessage = (e: MessageEvent) => {
    const m = e.data;
    try {
        if (m.type === "init") {
            W = m.w;
            H = m.h;
            CELL = m.cellMeters;
            cost = m.cost;
            dist = new Float64Array(W * H);
            prevCell = new Int32Array(W * H);
            settled = new Uint8Array(W * H);
            return;
        }
        if (m.type === "matrix") {
            const cells: number[] = m.cells.map(snap);
            const n = cells.length;
            const out = new Float64Array(n * n).fill(Infinity);
            const paths: (Int32Array | null)[] = new Array(n * n).fill(null);
            for (let i = 0; i < n; i++) {
                out[i * n + i] = 0;
                const targets = new Set(cells.filter((_, j) => j > i));
                if (!targets.size) continue;
                search(cells[i], targets);
                for (let j = i + 1; j < n; j++) {
                    const d = dist[cells[j]];
                    out[i * n + j] = out[j * n + i] = d;
                    if (d < Infinity) paths[i * n + j] = smooth(trace(cells[j]));
                }
            }
            (self as unknown as Worker).postMessage({ id: m.id, result: { dist: out, paths } });
            return;
        }
        if (m.type === "path") {
            const a = snap(m.from);
            const b = snap(m.to);
            search(a, new Set([b]), b);
            const d = dist[b];
            const result = d < Infinity ? { cells: smooth(trace(b)), length: d } : null;
            (self as unknown as Worker).postMessage({ id: m.id, result });
        }
    } catch (err) {
        (self as unknown as Worker).postMessage({ id: m.id, error: String(err) });
    }
};
