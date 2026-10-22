// Десктоп-версия (Electron): API основного процесса и «папки» игры поверх него.
// В браузере desktop === undefined, и приложение работает через File System Access, как раньше.

export interface GamePaths {
    screenshots: string | null;
    logs: string | null;
    screenshotsAuto: boolean;
    logsAuto: boolean;
}

export interface OverlayState {
    opacity: number;
    clickThrough: boolean;
    open: boolean;
}

type Unsub = () => void;

/** Запрос на распознавание предмета под курсором (из основного процесса в окно цены). */
export interface PriceScan {
    x: number;
    y: number;
    manual: boolean;
    debug: boolean;
    display: { id: number; bounds: { x: number; y: number; width: number; height: number }; scaleFactor: number };
}
export interface PriceResult {
    found: boolean;
    tooltip: boolean;
    width: number;
    height: number;
    tip?: { x: number; y: number; w: number; h: number } | null;
    name?: string;
    error?: string;
}
export interface PriceSettings {
    enabled: boolean;
    /** Сам при наведении (иначе только по горячей клавише). */
    auto: boolean;
    /** Работать, только пока запущена игра. */
    onlyWithGame: boolean;
    /** Сохранять кадры распознавания в папку отладки. */
    debug: boolean;
}
export interface PriceState extends PriceSettings {
    gameRunning: boolean;
    last?: string;
}
export interface UpdateState {
    status: "disabled" | "idle" | "checking" | "none" | "available" | "downloading" | "ready" | "error";
    current: string;
    version?: string;
    progress?: number;
    error?: string;
}
export interface AppPrefs {
    /** Крестик прячет окно в трей, а не закрывает приложение. */
    closeToTray: boolean;
}

export interface SherpaApi {
    platform: string;
    win: { minimize(): Promise<void>; toggleMaximize(): Promise<void>; close(): Promise<void>; isMaximized(): Promise<boolean>; onState(cb: (s: { maximized: boolean }) => void): Unsub };
    app: {
        info(): Promise<{ version: string; userData: string; content: string; dev: boolean }>;
        openExternal(url: string): Promise<void>;
        showFolder(p: string): Promise<void>;
        prefs(): Promise<AppPrefs>;
        setPrefs(patch: Partial<AppPrefs>): Promise<AppPrefs>;
    };
    price: {
        get(): Promise<PriceState>;
        set(patch: Partial<PriceSettings>): Promise<PriceState>;
        onState(cb: (s: PriceState) => void): Unsub;
        openDebug(): Promise<void>;
        onScan(cb: (r: PriceScan) => void): Unsub;
        result(r: PriceResult): void;
        debug(d: { png: string; text: string; box: unknown; item: string | null; score: number | null }): void;
    };
    update: {
        get(): Promise<UpdateState>;
        check(): Promise<UpdateState>;
        download(): Promise<void>;
        install(): Promise<void>;
        onState(cb: (s: UpdateState) => void): Unsub;
    };
    paths: { get(): Promise<GamePaths>; pick(kind: "shots" | "logs"): Promise<GamePaths>; reset(kind: "shots" | "logs"): Promise<GamePaths>; screenshotKey(): Promise<string | null> };
    fs: {
        list(dir: string): Promise<{ name: string; kind: "file" | "directory" }[]>;
        stat(file: string): Promise<{ size: number; mtimeMs: number }>;
        readText(file: string, start?: number, end?: number): Promise<string>;
        readBytes(file: string): Promise<ArrayBuffer>;
    };
    overlay: {
        open(): Promise<void>;
        close(): Promise<void>;
        set(patch: Partial<{ opacity: number; clickThrough: boolean }>): Promise<void>;
        getState(): Promise<OverlayState>;
        update(model: unknown): void;
        action(a: OverlayAction): void;
        hoverHandle(on: boolean): void;
        onModel(cb: (m: unknown) => void): Unsub;
        onState(cb: (s: OverlayState) => void): Unsub;
        onAction(cb: (a: OverlayAction) => void): Unsub;
        onClosed(cb: () => void): Unsub;
    };
    data: { sync(modes?: string[]): Promise<number>; info(): Promise<{ lastSync: number | null; hasUserData: boolean }>; onProgress(cb: (m: string) => void): Unsub };
}

export type OverlayAction = { type: "done" } | { type: "skip" } | { type: "stop" } | { type: "start"; raid: number } | { type: "dismiss" } | { type: "openMain" };

export const desktop: SherpaApi | undefined = (window as unknown as { sherpa?: SherpaApi }).sherpa;

/** Адрес файла данных: в приложении — app://app/… (свежая копия пользователя или встроенная), в браузере — рядом со страницей. */
export const dataUrl = (p: string) => (desktop ? `app://app/${p}` : import.meta.env.BASE_URL + p);

// ---------------- «папки» на основе файловой системы ----------------
// Повторяют нужную часть FileSystemDirectoryHandle, чтобы код логов и скриншотов работал без изменений.

const join = (dir: string, name: string) => (dir.endsWith("\\") || dir.endsWith("/") ? dir + name : `${dir}\\${name}`);

class DesktopFile {
    constructor(
        private api: SherpaApi,
        readonly path: string,
        readonly name: string,
        readonly size: number,
        readonly lastModified: number,
        private start = 0,
        private end?: number,
    ) {}
    text() {
        return this.start || this.end != null ? this.api.fs.readText(this.path, this.start, this.end ?? this.size) : this.api.fs.readText(this.path);
    }
    slice(start = 0, end?: number) {
        const s = start < 0 ? Math.max(0, this.size + start) : start;
        return new DesktopFile(this.api, this.path, this.name, this.size, this.lastModified, s, end ?? this.size);
    }
    async arrayBuffer() {
        return this.api.fs.readBytes(this.path);
    }
}

class DesktopFileHandle {
    readonly kind = "file" as const;
    constructor(
        private api: SherpaApi,
        readonly path: string,
        readonly name: string,
    ) {}
    async getFile() {
        const st = await this.api.fs.stat(this.path);
        return new DesktopFile(this.api, this.path, this.name, st.size, st.mtimeMs);
    }
}

export class DesktopDirHandle {
    readonly kind = "directory" as const;
    constructor(
        private api: SherpaApi,
        readonly path: string,
        readonly name: string,
    ) {}
    async *entries(): AsyncIterableIterator<[string, DesktopDirHandle | DesktopFileHandle]> {
        for (const e of await this.api.fs.list(this.path)) {
            const p = join(this.path, e.name);
            yield [e.name, e.kind === "directory" ? new DesktopDirHandle(this.api, p, e.name) : new DesktopFileHandle(this.api, p, e.name)];
        }
    }
    async getDirectoryHandle(name: string) {
        return new DesktopDirHandle(this.api, join(this.path, name), name);
    }
    async getFileHandle(name: string) {
        return new DesktopFileHandle(this.api, join(this.path, name), name);
    }
}

/** Папка игры как FileSystemDirectoryHandle (только чтение). */
export function desktopDir(p: string): FileSystemDirectoryHandle {
    const name = p.split(/[\\/]/).filter(Boolean).pop() ?? p;
    return new DesktopDirHandle(desktop!, p, name) as unknown as FileSystemDirectoryHandle;
}
