import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { Bundle, GameMode, Player, Task, TaskStatus, Vec3 } from "./types";
import { usePersistentState } from "./lib/store";
import { activeStops, loadout, objectivePoints, taskOnMap } from "./lib/quests";
import { DEFAULT_RAID_SETTINGS, planRaids, type Raid, type RaidPlan, type RaidSettings, type RaidStep } from "./lib/raids";
import { refineRaids } from "./lib/realRoutes";
import { loadSvgText, useNavGrid } from "./lib/useNavGrid";
import { useSticky } from "./lib/sticky";
import { dataUrl, desktop, desktopDir, type OverlayAction, type OverlayState } from "./lib/desktop";
import { computeHud, raidOffer, type OverlayModel } from "./lib/hudModel";
import WindowControls from "./components/TitleBar";
import { UpdateBadge } from "./components/DesktopPanels";
import { resetStyled } from "./lib/styledMaps";
import { detailRoute, type DetailRoute } from "./lib/navdetail";
import { dist as straightDist } from "./lib/route";
import {
    ensurePermission,
    loadHandle,
    pickDirectory,
    saveHandle,
    watchScreenshots,
    type PlayerFix,
} from "./lib/navigator";
import MapView, { type MapFocus } from "./components/MapView";
import QuestsTab, { type StopLabel } from "./components/QuestsTab";
import RaidsTab from "./components/RaidsTab";
import LoadoutTab from "./components/LoadoutTab";
import PlayersTab from "./components/PlayersTab";
import NavigatorTab, { type NavLink } from "./components/NavigatorTab";
import SetupWizard from "./components/SetupWizard";
import RaidPrompt from "./components/RaidPrompt";
import Hud, { type Session } from "./components/Hud";
import QuestScan from "./components/QuestScan";
import MarketTab from "./components/MarketTab";
import PriceTip from "./components/PriceTip";
import { hideTip, loadMarket, MarketContext, refreshMarket, showTip, type Market } from "./lib/market";
import { scanTaskHistory, watchLogs, type LogState } from "./lib/gamelogs";
import { applyActiveList, applyTaskEvents, type SyncSummary } from "./lib/progressSync";

type Tab = "quests" | "raids" | "loadout" | "market" | "nav" | "players";
type Which = "shots" | "logs";

/** Короткий сигнал о начале рейда. */
function beep() {
    try {
        const ctx = new AudioContext();
        const o = ctx.createOscillator();
        const g = ctx.createGain();
        o.frequency.value = 880;
        g.gain.setValueAtTime(0.08, ctx.currentTime);
        g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.35);
        o.connect(g).connect(ctx.destination);
        o.start();
        o.stop(ctx.currentTime + 0.35);
    } catch {
        /* звук недоступен — не страшно */
    }
}

export default function App() {
    const [state, setState] = usePersistentState();
    const [bundle, setBundle] = useState<Bundle | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [tab, setTab] = useSticky<Tab>("tab", "quests");
    const [focus, setFocus] = useState<MapFocus>();

    // планирование
    const [selectedRaid, setSelectedRaid] = useSticky<Record<string, number | null>>("selectedRaid", {});
    const [extractOverride, setExtractOverride] = useSticky<Record<string, Record<number, string>>>("extractOverride", {});
    const [includeShoot, setIncludeShoot] = useSticky("includeShoot", false);
    const [showOther, setShowOther] = useSticky("showOther", false);
    const [showExtracts, setShowExtracts] = useSticky("showExtracts", true);
    const [showLabels, setShowLabels] = useSticky("showLabels", true);
    const [showHazards, setShowHazards] = useSticky("showHazards", true);
    /** Пути: по сетке карты или прямыми линиями. */
    const [routeMode, setRouteMode] = useSticky<"real" | "straight">("routeMode", "real");
    /** Выходы, доступные в текущем рейде, по картам. Нет записи — доступны все. */
    const [availEx, setAvailEx] = useSticky<Record<string, string[]>>("availableExtracts", {});
    const raidSettings: RaidSettings = state.raidSettings ?? DEFAULT_RAID_SETTINGS;

    // навигатор
    const [session, setSession] = useState<Session>();
    const [fix, setFix] = useState<PlayerFix & { mapKey: string }>();
    const [logState, setLogState] = useState<LogState>();
    const [links, setLinks] = useState<Record<Which, NavLink>>({ shots: { status: "off" }, logs: { status: "off" } });
    const [handles, setHandles] = useState<Partial<Record<Which, FileSystemDirectoryHandle>>>({});
    const [follow, setFollow] = useSticky("follow", true);
    const [autoMap, setAutoMap] = useSticky("autoMap", true);
    const [pip, setPip] = useState<Window | null>(null);
    const [showSetup, setShowSetup] = useState(() => !state.setupDone);
    const [lastShot, setLastShot] = useState<string>();
    /** Время начала рейда (по логу), для которого уже показали предложение. */
    const [promptedRaid, setPromptedRaid] = useSticky<number>("raid.prompted", 0);
    const [raidNote, setRaidNote] = useState<string>();
    // плавающий виджет: позиция и компактный режим запоминаются
    const [hudPos, setHudPos] = useSticky<{ x: number; y: number } | null>("hud.pos", null);
    const [hudCompact, setHudCompact] = useSticky("hud.compact", false);
    /** Номер версии данных: растёт после обновления из tarkov.dev — данные перечитываются. */
    const [dataRev, setDataRev] = useState(0);
    /** Окно-виджет поверх игры (десктоп). */
    const [ovState, setOvState] = useState<OverlayState>({ opacity: 0.6, clickThrough: false, open: false });
    const screenshotKey = state.screenshotKey || "Print Screen";

    useEffect(() => {
        setBundle(null);
        setError(null);
        fetch(dataUrl(`data/${state.mode}.json`))
            .then((r) => {
                if (!r.ok) throw new Error(`Нет файла данных (${r.status}). Запусти «npm run sync».`);
                return r.json();
            })
            .then(setBundle)
            .catch((e) => setError(e.message));
    }, [state.mode, dataRev]);

    const gameMap = bundle?.maps.find((m) => m.key === state.mapKey) ?? bundle?.maps[0];
    const mapKey = gameMap?.key ?? "";
    const mapKeyRef = useRef(mapKey);
    mapKeyRef.current = mapKey;

    // ---------- цены ----------
    const [market, setMarket] = useState<Market | null>(null);
    useEffect(() => {
        setMarket(null);
        loadMarket(state.mode).then(setMarket).catch((e) => console.warn(e));
    }, [state.mode, dataRev]);
    const marketCtx = useMemo(
        () => ({
            market,
            intel: !!state.intelCenter,
            traders: bundle?.traders ?? {},
            showTip,
            hideTip,
        }),
        [market, state.intelCenter, bundle],
    );

    // ---------- рейды ----------
    const allowedExtracts = useMemo(() => (availEx[mapKey] ? new Set(availEx[mapKey]) : undefined), [availEx, mapKey]);
    const stops = useMemo(() => (bundle && gameMap ? activeStops(bundle, state.players, mapKey, includeShoot) : []), [bundle, gameMap, state.players, mapKey, includeShoot]);
    const rawPlan: RaidPlan = useMemo(
        () => (gameMap ? planRaids(gameMap, stops, raidSettings, extractOverride[mapKey], allowedExtracts) : { raids: [], budgetSec: 0, raidSec: 0 }),
        [gameMap, stops, raidSettings, extractOverride, mapKey, allowedExtracts],
    );

    // Реальные пути по сетке проходимости: считаются в фоне, до готовности — прямые линии.
    const { svc: gridSvc, status: navStatus } = useNavGrid(gameMap);
    // «По прямой» — сервис путей не используется вовсе
    const svc = routeMode === "real" ? gridSvc : null;
    const [refined, setRefined] = useState<{ from: RaidPlan; raids: Raid[] }>();
    useEffect(() => {
        if (!svc || !gameMap || !rawPlan.raids.length) return;
        let cancelled = false;
        refineRaids(svc, gameMap, rawPlan, raidSettings, extractOverride[mapKey], allowedExtracts)
            .then((raids) => !cancelled && setRefined({ from: rawPlan, raids }))
            .catch((e) => console.warn("Не удалось уточнить пути:", e));
        return () => {
            cancelled = true;
        };
    }, [svc, rawPlan, gameMap, raidSettings, extractOverride, mapKey, allowedExtracts]);
    const plan: RaidPlan = useMemo(() => (svc && refined?.from === rawPlan ? { ...rawPlan, raids: refined.raids } : rawPlan), [svc, refined, rawPlan]);
    const routesState =
        routeMode === "straight" ? "straight" : navStatus === "ready" ? (refined?.from === rawPlan || !rawPlan.raids.length ? "real" : "computing") : navStatus;
    const sel = selectedRaid[mapKey] ?? null;
    const setSel = (i: number | null) => setSelectedRaid((s) => ({ ...s, [mapKey]: i }));

    const sideTasks = useMemo(() => {
        if (!bundle) return [];
        const out: { task: Task; text: string; players: Player[] }[] = [];
        for (const task of bundle.tasks) {
            const owners = state.players.filter((p) => p.tasks[task.id] === "active");
            if (!owners.length) continue;
            for (const o of task.objectives) {
                if (!(o.maps.includes(mapKey) || (task.map === mapKey && !o.maps.length))) continue;
                if (objectivePoints(o, mapKey).length && !(o.type === "shoot" && !includeShoot)) continue;
                if (["giveItem", "giveQuestItem", "taskStatus", "traderLevel", "traderStanding", "skill", "sellItem", "buildWeapon"].includes(o.type)) continue;
                const who = owners.filter((p) => !p.objectivesDone[o.id]);
                if (who.length) out.push({ task, text: o.text, players: who });
            }
        }
        return out;
    }, [bundle, state.players, mapKey, includeShoot]);

    const otherTasks = useMemo(
        () => (bundle && showOther ? bundle.tasks.filter((t) => taskOnMap(t, mapKey) && !state.players.some((p) => p.tasks[t.id])) : []),
        [bundle, showOther, mapKey, state.players],
    );
    const gear = useMemo(() => (bundle ? loadout(bundle, state.players, mapKey) : null), [bundle, state.players, mapKey]);

    // ---------- прогресс ----------
    const setTaskStatus = useCallback(
        (playerId: string, taskId: string, s: TaskStatus | undefined) =>
            setState((st) => ({
                ...st,
                players: st.players.map((p) => {
                    if (p.id !== playerId) return p;
                    const tasks = { ...p.tasks };
                    if (s) tasks[taskId] = s;
                    else delete tasks[taskId];
                    return { ...p, tasks };
                }),
            })),
        [setState],
    );
    const setObjective = useCallback(
        (playerIds: string[], objectiveId: string, done: boolean | "toggle") =>
            setState((st) => ({
                ...st,
                players: st.players.map((p) => {
                    if (!playerIds.includes(p.id)) return p;
                    const d = { ...p.objectivesDone };
                    const v = done === "toggle" ? !d[objectiveId] : done;
                    if (v) d[objectiveId] = true;
                    else delete d[objectiveId];
                    return { ...p, objectivesDone: d };
                }),
            })),
        [setState],
    );
    const takeTask = useCallback(
        (taskId: string) => {
            const me = state.players.find((p) => p.id === state.activePlayer) ?? state.players[0];
            setTaskStatus(me.id, taskId, "active");
        },
        [state.players, state.activePlayer, setTaskStatus],
    );

    // ---------- сессия рейда ----------
    const isDone = useCallback(
        (s: RaidStep) =>
            s.stop.players.every((p) => {
                const live = state.players.find((x) => x.id === p.id);
                return !live || !!live.objectivesDone[s.stop.objective.id];
            }),
        [state.players],
    );
    const sessionOnMap = session && session.raid.steps[0] && plan ? session : undefined;
    const remaining = sessionOnMap ? sessionOnMap.raid.steps.filter((s) => !isDone(s) && !sessionOnMap.skipped.includes(s.stop.id)) : [];
    const target = remaining[0];
    const doneStops = useMemo(() => new Set((session?.raid.steps ?? plan.raids.flatMap((r) => r.steps)).filter(isDone).map((s) => s.stop.id)), [session, plan, isDone]);

    const startRaid = (i: number) => {
        const raid = plan.raids[i];
        if (!raid) return;
        setSession({ raid, startedAt: Date.now(), skipped: [] });
        setSel(i);
        setTab("nav");
    };
    const stopRaid = () => {
        setSession(undefined);
        pip?.close();
    };
    const markDone = () => target && setObjective(target.stop.players.map((p) => p.id), target.stop.objective.id, true);
    const skip = () => target && setSession((s) => (s ? { ...s, skipped: [...s.skipped, target.stop.id] } : s));


    // ---------- рейд по логам ----------
    const raidStartLog = logState?.raidStart;
    const raidActive = !!raidStartLog && (!logState?.raidEnd || logState.raidEnd < raidStartLog) && Date.now() - raidStartLog < 75 * 60_000;
    const showRaidPrompt = !session && raidActive && raidStartLog !== promptedRaid;
    useEffect(() => {
        if (!showRaidPrompt) return;
        beep();
        if (typeof Notification !== "undefined" && Notification.permission === "granted" && document.hidden) {
            const n = new Notification("Sherpa: рейд начался", { body: `${gameMap?.name ?? "Карта"} — открыть навигатор?`, tag: "sherpa-raid" });
            n.onclick = () => {
                window.focus();
                n.close();
            };
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [showRaidPrompt, raidStartLog]);
    // выход из рейда (UserMatchOver в логе) — сессия закрывается сама
    useEffect(() => {
        const end = logState?.raidEnd;
        if (!session || !end || end < session.startedAt) return;
        const done = session.raid.steps.filter(isDone).length;
        setRaidNote(`Рейд завершён: выполнено ${done} из ${session.raid.steps.length} целей.`);
        setSession(undefined);
        pip?.close();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [logState?.raidEnd]);
    // десктоп: при начале рейда виджет открывается сам и предлагает маршрут прямо поверх игры
    useEffect(() => {
        if (desktop && showRaidPrompt && state.autoOverlay !== false) desktop.overlay.open();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [showRaidPrompt, raidStartLog]);

    // ---------- папки игры ----------
    const setLink = (w: Which, l: NavLink) => setLinks((s) => ({ ...s, [w]: l }));

    /** Десктоп: папки игры найдены автоматически (или выбраны вручную) — без запросов разрешений. */
    const applyDesktopPaths = useCallback((p: { screenshots: string | null; logs: string | null }) => {
        setHandles({ shots: p.screenshots ? desktopDir(p.screenshots) : undefined, logs: p.logs ? desktopDir(p.logs) : undefined });
        setLinks({
            shots: p.screenshots ? { status: "on", name: p.screenshots } : { status: "off", error: "Папка не найдена — сделай скриншот в игре или выбери папку вручную" },
            logs: p.logs ? { status: "on", name: p.logs } : { status: "off", error: "Игра не найдена — выбери папку Logs вручную" },
        });
    }, []);
    useEffect(() => {
        if (!desktop) return;
        desktop.paths.get().then(applyDesktopPaths);
        // клавиша скриншота — из настроек управления игры, если удастся прочитать
        desktop.paths.screenshotKey().then((k) => k && setState((st) => (st.screenshotKey ? st : { ...st, screenshotKey: k })));
        desktop.overlay.getState().then(setOvState);
        const off = desktop.overlay.onState(setOvState);
        return off;
    }, [applyDesktopPaths, setState]);

    useEffect(() => {
        if (desktop) return;
        (["shots", "logs"] as Which[]).forEach(async (w) => {
            const h = await loadHandle(w);
            if (!h) return;
            setHandles((s) => ({ ...s, [w]: h }));
            const ok = await ensurePermission(h, false);
            setLink(w, { status: ok ? "on" : "need-permission", name: h.name });
        });
    }, []);

    const connect = async (w: Which) => {
        if (desktop) {
            applyDesktopPaths(await desktop.paths.pick(w));
            return;
        }
        try {
            let h = handles[w];
            if (h && links[w].status === "need-permission") {
                if (!(await ensurePermission(h, true))) return;
            } else {
                h = await pickDirectory(w === "shots" ? "eft-screenshots" : "eft-logs");
                await saveHandle(w, h);
            }
            setHandles((s) => ({ ...s, [w]: h }));
            setLink(w, { status: "on", name: h.name });
        } catch (e) {
            if ((e as Error).name !== "AbortError") setLink(w, { status: "error", error: (e as Error).message });
        }
    };
    const disconnect = async (w: Which) => {
        if (desktop) {
            applyDesktopPaths(await desktop.paths.reset(w));
            return;
        }
        await saveHandle(w, undefined);
        setHandles((s) => ({ ...s, [w]: undefined }));
        setLink(w, { status: "off" });
    };

    useEffect(() => {
        const h = handles.shots;
        if (!h || links.shots.status !== "on") return;
        return watchScreenshots(
            h,
            (f) => {
                setFix({ ...f, mapKey: mapKeyRef.current });
                setLastShot(f.file);
            },
            (e) => setLink("shots", { status: "error", name: h.name, error: e.message }),
        );
    }, [handles.shots, links.shots.status]);

    useEffect(() => {
        const h = handles.logs;
        if (!h || links.logs.status !== "on") return;
        return watchLogs(h, setLogState, (e) => setLink("logs", { status: "error", name: h.name, error: e.message }));
    }, [handles.logs, links.logs.status]);

    // ---------- квесты из логов ----------
    const [syncNote, setSyncNote] = useState<string>();
    const [historyProgress, setHistoryProgress] = useState<string>();
    const describeSync = (s: SyncSummary) =>
        [s.started && `взято ${s.started}`, s.finished && `выполнено ${s.finished}`, s.failed && `провалено ${s.failed}`, s.inferred && `по цепочкам +${s.inferred}`]
            .filter(Boolean)
            .join(", ");
    const applyEvents = useCallback(
        (events: LogState["taskEvents"], fromScratch: boolean) => {
            if (!bundle) return;
            setState((st) => {
                const me = st.players.find((p) => p.id === st.activePlayer) ?? st.players[0];
                const since = fromScratch ? 0 : st.logSync?.[st.mode] ?? 0;
                const r = applyTaskEvents(bundle, me, events, st.mode, since);
                const total = r.summary.started + r.summary.finished + r.summary.failed + r.summary.inferred;
                if (!total && r.last === since) return st;
                if (total) setSyncNote(`${me.name}: ${describeSync(r.summary)} (${new Date().toLocaleTimeString("ru-RU")})`);
                return { ...st, players: st.players.map((p) => (p.id === me.id ? r.player : p)), logSync: { ...st.logSync, [st.mode]: r.last } };
            });
        },
        [bundle, setState],
    );
    useEffect(() => {
        if (state.autoSync === false || !logState?.taskEvents.length) return;
        applyEvents(logState.taskEvents, false);
    }, [logState?.taskEvents, state.autoSync, applyEvents]);
    const syncHistory = async () => {
        const h = handles.logs;
        if (!h) return;
        try {
            const events = await scanTaskHistory(h, (d, t) => setHistoryProgress(`читаю логи: ${d} из ${t}`));
            setHistoryProgress(undefined);
            if (!events.length) {
                setSyncNote("В логах не нашлось событий квестов.");
                return;
            }
            applyEvents(events, true);
        } catch (e) {
            setHistoryProgress(undefined);
            setSyncNote("Ошибка чтения логов: " + (e as Error).message);
        }
    };
    const applyScanned = (playerId: string, ids: string[]) => {
        const p = state.players.find((x) => x.id === playerId);
        if (!bundle || !p) return "";
        const r = applyActiveList(bundle, p, ids);
        setState((st) => ({ ...st, players: st.players.map((x) => (x.id === playerId ? r.player : x)) }));
        return `${p.name}: активных ${ids.length} (новых ${r.added}), выполнено по цепочкам +${r.inferred}`;
    };

    // режим PvP/PvE — по логам
    useEffect(() => {
        const m = logState?.sessionMode;
        if (!autoMap || (m !== "pve" && m !== "regular")) return;
        setState((s) => (s.mode === m ? s : { ...s, mode: m }));
    }, [logState?.sessionMode, autoMap, setState]);

    // карта из логов
    useEffect(() => {
        if (!autoMap || !logState?.mapNameId || !bundle) return;
        const m = bundle.maps.find((x) => x.variants.some((v) => v.nameId.toLowerCase() === logState.mapNameId!.toLowerCase()));
        if (m && m.key !== mapKeyRef.current) setState((s) => ({ ...s, mapKey: m.key }));
    }, [logState?.mapNameId, autoMap, bundle, setState]);

    // ---------- окно поверх игры ----------
    const openPip = async () => {
        if (desktop) {
            await desktop.overlay.open();
            return;
        }
        // Chrome/Edge: окно Picture-in-Picture всегда поверх остальных.
        // Если недоступно — обычное всплывающее окно (закрепить поверх: PowerToys, Win+Ctrl+T).
        let w: Window | null = null;
        try {
            w = (await window.documentPictureInPicture?.requestWindow({ width: 340, height: 620 })) ?? null;
        } catch {
            w = null;
        }
        if (!w) w = window.open("", "sherpa-hud", "popup,width=340,height=640");
        if (!w) {
            alert("Браузер заблокировал окно. Разреши всплывающие окна для этого сайта.");
            return;
        }
        w.document.head.innerHTML = "";
        for (const sheet of Array.from(document.styleSheets)) {
            try {
                const style = w.document.createElement("style");
                style.textContent = Array.from(sheet.cssRules).map((r) => r.cssText).join("\n");
                w.document.head.appendChild(style);
            } catch {
                if (sheet.href) {
                    const link = w.document.createElement("link");
                    link.rel = "stylesheet";
                    link.href = sheet.href;
                    w.document.head.appendChild(link);
                }
            }
        }
        w.document.title = "Sherpa · навигатор";
        w.document.body.className = "pip";
        w.addEventListener("pagehide", () => setPip(null));
        setPip(w);
    };

    const doFocus = useCallback((position: Vec3) => setFocus({ position, seq: Date.now() }), []);
    const toggleObjectiveOne = useCallback((pid: string, oid: string) => setObjective([pid], oid, "toggle"), [setObjective]);
    const [detailSel, setDetailSel] = useState<{ raid: number; stopId: string }>();
    const sessionRef = useRef(session);
    sessionRef.current = session;
    const onSelectStop = useCallback(
        (stopId: string, raid: number) => {
            if (!sessionRef.current) {
                setSelectedRaid((s) => ({ ...s, [mapKeyRef.current]: raid }));
                setDetailSel({ raid, stopId });
            }
            setTab(sessionRef.current ? "nav" : "raids");
        },
        [setSelectedRaid, setTab],
    );
    const visibleFix = fix && fix.mapKey === mapKey ? fix : undefined;

    // Путь для навигатора: по общей сетке, а у цели (≤140 м) — подробный, через двери и лестницы.
    const [guide, setGuide] = useState<{ points: [number, number][]; length: number; detail?: DetailRoute }>();
    const goal = target?.point ?? session?.raid.extract?.position;
    useEffect(() => {
        if (!svc || !visibleFix || !goal || !gameMap) {
            setGuide(undefined);
            return;
        }
        let cancelled = false;
        (async () => {
            const ov = await svc.path(visibleFix.position, goal);
            let result: typeof guide = ov ?? undefined;
            if (gameMap.display.svgPath && straightDist(visibleFix.position, goal) < 140) {
                const text = await loadSvgText(gameMap.display.svgPath);
                const d = await detailRoute(gameMap, text, visibleFix.position, goal, ov?.points ?? null);
                if (d) result = { points: [...d.approach, ...d.segments.flatMap((sg) => sg.points)], length: d.length, detail: d };
            }
            if (!cancelled) setGuide(result);
        })().catch(() => !cancelled && setGuide(undefined));
        return () => {
            cancelled = true;
        };
    }, [svc, visibleFix, goal, gameMap]);

    // Подробный путь к выбранной цели в режиме планирования (клик по точке).
    const [planDetail, setPlanDetail] = useState<{ stopId: string; route: DetailRoute | null; loading: boolean }>();
    useEffect(() => setDetailSel(undefined), [mapKey]);
    useEffect(() => {
        const raid = detailSel ? plan.raids[detailSel.raid] : undefined;
        const i = raid ? raid.steps.findIndex((st) => st.stop.id === detailSel!.stopId) : -1;
        if (!raid || i < 0 || !gameMap?.display.svgPath || !svc) {
            setPlanDetail(undefined);
            return;
        }
        const to = raid.steps[i].point;
        const from = i > 0 ? raid.steps[i - 1].point : raid.spawn ?? raid.extract?.position ?? to;
        // общий путь к этой точке — соответствующий отрезок рейда
        const legIdx = raid.spawn ? i : i - 1;
        const leg = raid.legs && legIdx >= 0 ? raid.legs[legIdx] : null;
        let cancelled = false;
        setPlanDetail({ stopId: detailSel!.stopId, route: null, loading: true });
        (async () => {
            const text = await loadSvgText(gameMap.display.svgPath!);
            let overview = leg;
            if (!overview && svc) overview = (await svc.path(from, to))?.points ?? null;
            const r = await detailRoute(gameMap, text, from, to, overview);
            if (!cancelled) setPlanDetail({ stopId: detailSel!.stopId, route: r, loading: false });
        })().catch(() => !cancelled && setPlanDetail({ stopId: detailSel!.stopId, route: null, loading: false }));
        return () => {
            cancelled = true;
        };
    }, [detailSel, plan, gameMap, svc]);
    const mapDetail = session ? guide?.detail : planDetail?.route ?? undefined;

    const mainRef = useRef<HTMLElement>(null);
    const startHudDrag = (e: React.PointerEvent) => {
        const box = (e.currentTarget as HTMLElement).closest(".hud-float") as HTMLElement | null;
        const main = mainRef.current;
        if (!box || !main) return;
        e.preventDefault();
        const m = main.getBoundingClientRect();
        const b = box.getBoundingClientRect();
        const dx = e.clientX - b.left;
        const dy = e.clientY - b.top;
        const move = (ev: PointerEvent) => {
            const x = Math.min(Math.max(0, ev.clientX - m.left - dx), m.width - b.width);
            const y = Math.min(Math.max(0, ev.clientY - m.top - dy), m.height - 40);
            box.style.left = x + "px";
            box.style.top = y + "px";
            box.style.right = "auto";
            box.style.bottom = "auto";
        };
        const up = () => {
            window.removeEventListener("pointermove", move);
            window.removeEventListener("pointerup", up);
            setHudPos({ x: parseFloat(box.style.left) || 0, y: parseFloat(box.style.top) || 0 });
        };
        window.addEventListener("pointermove", move);
        window.addEventListener("pointerup", up);
    };

    const hud =
        session && gameMap ? (
            <Hud
                map={gameMap}
                session={session}
                fix={visibleFix}
                target={target}
                remaining={remaining}
                extract={session.raid.extract}
                onDone={markDone}
                onSkip={skip}
                onStop={stopRaid}
                raidStartFromLog={logState?.raidStart}
                guide={guide}
                compact={hudCompact}
                onToggleCompact={() => setHudCompact(!hudCompact)}
                screenshotKey={screenshotKey}
            />
        ) : null;

    // ---------- окно-виджет (десктоп): модель туда, действия оттуда ----------
    const lastSent = useRef("");
    useEffect(() => {
        if (!desktop) return;
        let m: OverlayModel = { kind: "idle" };
        if (session && gameMap) {
            const logStart = logState?.raidStart;
            const timerStart = logStart && logStart > session.startedAt - 10 * 60_000 ? logStart : session.startedAt;
            m = {
                kind: "hud",
                hud: computeHud({ map: gameMap, raid: session.raid, timerStart, fix: visibleFix, target, remaining, extract: session.raid.extract, guide, screenshotKey, now: Date.now() }),
            };
        } else if (showRaidPrompt && gameMap && raidStartLog) {
            m = { kind: "offer", offer: raidOffer(gameMap.name, raidStartLog, plan.raids, sel ?? plan.raids.find((r) => r.best)?.index ?? 0) };
        }
        const key = JSON.stringify(m);
        if (key === lastSent.current) return;
        lastSent.current = key;
        desktop.overlay.update(m);
    });
    const actionRef = useRef<(a: OverlayAction) => void>(() => {});
    actionRef.current = (a) => {
        if (a.type === "done") markDone();
        else if (a.type === "skip") skip();
        else if (a.type === "stop") stopRaid();
        else if (a.type === "start") {
            if (raidStartLog) setPromptedRaid(raidStartLog);
            startRaid(a.raid);
        } else if (a.type === "dismiss" && raidStartLog) setPromptedRaid(raidStartLog);
    };
    useEffect(() => (desktop ? desktop.overlay.onAction((a) => actionRef.current(a)) : undefined), []);

    const applyScannedRef = useRef(applyScanned);
    applyScannedRef.current = applyScanned;
    const shotsDir = links.shots.status === "on" ? handles.shots : undefined;
    const scanEl = useMemo(
        () => (bundle ? <QuestScan bundle={bundle} players={state.players} activePlayer={state.activePlayer} shotsDir={shotsDir} onApply={(p, ids) => applyScannedRef.current(p, ids)} /> : null),
        [bundle, state.players, state.activePlayer, shotsDir],
    );

    const mapPlan: RaidPlan = useMemo(() => (session ? { ...plan, raids: [{ ...session.raid, index: 0 }] } : plan), [session, plan]);

    // номера точек маршрута для карточек квестов — те же, что на карте
    const stopLabels = useMemo(() => {
        const m = new Map<string, StopLabel>();
        for (const r of mapPlan.raids) r.steps.forEach((st, i) => m.set(st.stop.objective.id, { label: `${r.index + 1}.${i + 1}`, color: r.color }));
        return m;
    }, [mapPlan]);
    const mapPlanRef = useRef(mapPlan);
    mapPlanRef.current = mapPlan;
    const pickStop = useCallback(
        (objectiveId: string) => {
            for (const r of mapPlanRef.current.raids) {
                const st = r.steps.find((s) => s.stop.objective.id === objectiveId);
                if (!st) continue;
                onSelectStop(st.stop.id, r.index);
                setTab("quests"); // остаёмся в квестах, карта покажет точку
                setFocus({ position: st.point, seq: Date.now() });
                return;
            }
        },
        [onSelectStop, setTab],
    );

    return (
        <MarketContext.Provider value={marketCtx}>
        <div className="app">
            <header className={"topbar" + (desktop ? " desktop" : "")}>
                <div className="brand">
                    <span className="logo">SHERPA</span>
                    <span className="sub">квестовый проводник</span>
                </div>
                <div className="seg mode">
                    {(["regular", "pve"] as GameMode[]).map((m) => (
                        <button key={m} className={state.mode === m ? "on" : ""} onClick={() => setState({ ...state, mode: m })}>
                            {m === "regular" ? "PVP" : "PVE"}
                        </button>
                    ))}
                </div>
                <nav className="maps">
                    {bundle?.maps.map((m) => (
                        <button key={m.key} className={m.key === mapKey ? "on" : ""} onClick={() => setState({ ...state, mapKey: m.key })}>
                            {m.name}
                        </button>
                    ))}
                </nav>
                <div className="conn">
                    {(["shots", "logs"] as Which[]).map((w) => {
                        const l = links[w];
                        const label = w === "shots" ? "Скриншоты" : "Логи";
                        const hint =
                            l.status === "on"
                                ? `${label}: подключено`
                                : l.status === "need-permission"
                                  ? `${label}: браузер снова просит разрешение — нажми`
                                  : `${label}: не настроено — открыть мастер`;
                        return (
                            <button
                                key={w}
                                className={"conn-chip " + l.status}
                                title={hint}
                                onClick={() => (l.status === "need-permission" ? connect(w) : l.status !== "on" ? setShowSetup(true) : setTab("nav"))}
                            >
                                <span className="led" />
                                {label}
                                {l.status === "need-permission" && <small> · разрешить</small>}
                            </button>
                        );
                    })}
                    {session && <span className="conn-chip on raid">● в рейде</span>}
                </div>
                <UpdateBadge />
                <button className="setup-btn" onClick={() => setShowSetup(true)} title="Первая настройка: папки игры, виджет, группа">
                    ⚙ Настройка
                </button>
                <WindowControls />
            </header>

            {error && <div className="fatal">{error}</div>}
            {!bundle && !error && <div className="fatal">Загрузка данных…</div>}

            {bundle && gameMap && gear && (
                <div className="shell">
                    <main ref={mainRef}>
                        <MapView
                            bundle={bundle}
                            map={gameMap}
                            plan={mapPlan}
                            selectedRaid={session ? 0 : sel}
                            doneStops={doneStops}
                            targetStop={target?.stop.id}
                            otherTasks={otherTasks}
                            showOther={showOther}
                            showExtracts={showExtracts}
                            showLabels={showLabels}
                            fix={visibleFix}
                            guide={session && !guide?.detail ? guide?.points : undefined}
                            detail={mapDetail}
                            follow={follow && !!session}
                            onTakeTask={takeTask}
                            focus={focus}
                            onSelectStop={onSelectStop}
                            showHazards={showHazards}
                            availableExtracts={allowedExtracts}
                        />
                        <div className="map-toggles">
                            <label className="check"><input type="checkbox" checked={showLabels} onChange={(e) => setShowLabels(e.target.checked)} /> районы</label>
                            <label className="check"><input type="checkbox" checked={showExtracts} onChange={(e) => setShowExtracts(e.target.checked)} /> выходы</label>
                            <label className="check"><input type="checkbox" checked={showOther} onChange={(e) => setShowOther(e.target.checked)} /> невзятые квесты</label>
                            <label className="check"><input type="checkbox" checked={showHazards} onChange={(e) => setShowHazards(e.target.checked)} /> опасности</label>
                        </div>
                        {hud && !pip && !(desktop && ovState.open) && (
                            <div className="hud-float" style={hudPos ? { left: hudPos.x, top: hudPos.y, right: "auto", bottom: "auto" } : undefined}>
                                {/* ручка перетаскивания — верхняя полоса HUD */}
                                <div onPointerDown={(e) => (e.target as HTMLElement).closest(".hud-top") && startHudDrag(e)}>{hud}</div>
                            </div>
                        )}
                        {showRaidPrompt && gameMap && raidStartLog && !(desktop && ovState.open) && (
                            <RaidPrompt
                                mapName={gameMap.name}
                                startedAt={raidStartLog}
                                plan={plan}
                                defaultRaid={sel ?? plan.raids.find((r) => r.best)?.index ?? 0}
                                onStart={(i, overlay) => {
                                    setPromptedRaid(raidStartLog);
                                    startRaid(i);
                                    if (overlay) openPip();
                                }}
                                onDismiss={() => setPromptedRaid(raidStartLog)}
                            />
                        )}
                        {raidNote && (
                            <div className="raid-prompt done" onClick={() => setRaidNote(undefined)}>
                                {raidNote} <span className="muted">(нажми, чтобы скрыть)</span>
                            </div>
                        )}
                    </main>
                    <aside>
                        <div className="tabs">
                            {(
                                [
                                    ["quests", "Квесты"],
                                    ["raids", `Рейды${plan.raids.length ? ` ${plan.raids.length}` : ""}`],
                                    ["loadout", "Снаряжение"],
                                    ["market", "Барахолка"],
                                    ["nav", session ? "● Навигатор" : "Навигатор"],
                                    ["players", "Группа"],
                                ] as [Tab, string][]
                            ).map(([k, label]) => (
                                <button key={k} className={tab === k ? "on" : ""} onClick={() => setTab(k)}>
                                    {label}
                                </button>
                            ))}
                        </div>
                        <div className="tab-scroll">
                            {tab === "quests" && (
                                <QuestsTab
                                    bundle={bundle}
                                    players={state.players}
                                    mapKey={mapKey}
                                    mapName={gameMap.name}
                                    setTaskStatus={setTaskStatus}
                                    toggleObjective={toggleObjectiveOne}
                                    onFocus={doFocus}
                                    scan={scanEl}
                                    stopLabels={stopLabels}
                                    onPickStop={pickStop}
                                />
                            )}
                            {tab === "raids" && (
                                <RaidsTab
                                    bundle={bundle}
                                    map={gameMap}
                                    plan={plan}
                                    players={state.players}
                                    settings={raidSettings}
                                    setSettings={(s) => setState((st) => ({ ...st, raidSettings: s }))}
                                    selected={sel}
                                    setSelected={setSel}
                                    extractOverride={extractOverride[mapKey] ?? {}}
                                    setExtractOverride={(o) => setExtractOverride((all) => ({ ...all, [mapKey]: o }))}
                                    includeShoot={includeShoot}
                                    setIncludeShoot={setIncludeShoot}
                                    sideTasks={sideTasks}
                                    onStart={startRaid}
                                    onFocusStop={(id, r) => {
                                        setSel(r);
                                        setDetailSel(detailSel?.stopId === id ? undefined : { raid: r, stopId: id });
                                        const st = plan.raids[r]?.steps.find((s) => s.stop.id === id);
                                        if (st) doFocus(st.point);
                                    }}
                                    sessionRaid={session?.raid.name}
                                    routesState={routesState}
                                    routeMode={routeMode}
                                    setRouteMode={setRouteMode}
                                    availableExtracts={availEx[mapKey]}
                                    setAvailableExtracts={(list) =>
                                        setAvailEx((all) => {
                                            const next = { ...all };
                                            if (list) next[mapKey] = list;
                                            else delete next[mapKey];
                                            return next;
                                        })
                                    }
                                    detail={planDetail}
                                />
                            )}
                            {tab === "loadout" && <LoadoutTab bundle={bundle} loadout={gear} mapName={gameMap.name} />}
                            {tab === "market" && (
                                <MarketTab
                                    mode={state.mode}
                                    onRefresh={async () => {
                                        if (market) setMarket(await refreshMarket(market));
                                    }}
                                    setIntel={(b) => setState((st) => ({ ...st, intelCenter: b }))}
                                    shotsDir={links.shots.status === "on" ? handles.shots : undefined}
                                />
                            )}
                            {tab === "nav" && (
                                <>
                                    {hud && pip && <div className="hud-inline">{hud}</div>}
                                    <NavigatorTab
                                        shots={links.shots}
                                        logs={links.logs}
                                        connectShots={() => connect("shots")}
                                        connectLogs={() => connect("logs")}
                                        disconnect={disconnect}
                                        fix={fix}
                                        log={logState}
                                        follow={follow}
                                        setFollow={setFollow}
                                        autoMap={autoMap}
                                        setAutoMap={setAutoMap}
                                        pipOpen={desktop ? ovState.open : !!pip}
                                        openPip={openPip}
                                        pipSupported={true}
                                        sessionActive={!!session}
                                        meName={(state.players.find((x) => x.id === state.activePlayer) ?? state.players[0]).name}
                                        autoSync={state.autoSync !== false}
                                        setAutoSync={(b) => setState((st) => ({ ...st, autoSync: b }))}
                                        onSyncHistory={syncHistory}
                                        syncNote={syncNote}
                                        historyProgress={historyProgress}
                                        screenshotKey={state.screenshotKey ?? ""}
                                        setScreenshotKey={(k) => setState((st) => ({ ...st, screenshotKey: k }))}
                                        autoOverlay={state.autoOverlay !== false}
                                        setAutoOverlay={(b) => setState((st) => ({ ...st, autoOverlay: b }))}
                                        overlay={ovState}
                                        onDataUpdated={() => {
                                            resetStyled();
                                            setDataRev((n) => n + 1);
                                        }}
                                    />
                                </>
                            )}
                            {tab === "players" && <PlayersTab state={state} setState={setState} />}
                        </div>
                        <footer>
                            Данные <a href="https://tarkov.dev" target="_blank" rel="noreferrer">tarkov.dev</a> от {new Date(bundle.generatedAt).toLocaleDateString("ru-RU")} · карты{" "}
                            <a href="https://github.com/the-hideout/tarkov-dev-svg-maps" target="_blank" rel="noreferrer">tarkov-dev-svg-maps</a> (CC BY-NC-SA 4.0)
                        </footer>
                    </aside>
                </div>
            )}
            {pip && hud && createPortal(hud, pip.document.body)}
            {showSetup && (
                <SetupWizard
                    state={state}
                    setState={setState}
                    shots={links.shots}
                    logs={links.logs}
                    connect={connect}
                    log={logState}
                    lastShot={lastShot}
                    onSyncHistory={syncHistory}
                    historyProgress={historyProgress}
                    syncNote={syncNote}
                    screenshotKey={screenshotKey}
                    overlayOpen={ovState.open}
                    onClose={() => {
                        setShowSetup(false);
                        setState((s) => ({ ...s, setupDone: true }));
                    }}
                />
            )}
            <PriceTip />
        </div>
        </MarketContext.Provider>
    );
}
