// Защита окон приложения.
//
//  - окна показывают только интерфейс Sherpa (app://app или dev-сервер при разработке): переходы на другие адреса
//    запрещены, новые окна не открываются, внешние ссылки — в браузере и только на известные сайты;
//  - из разрешений браузера выдаются только нужные (уведомления, захват экрана для цены, буфер обмена);
//  - для страниц задаётся Content-Security-Policy: скрипты только свои, сеть — только к источникам данных.

import { app, session, shell } from "electron";

/** Источник адреса; у app:// стандартный URL.origin даёт "null", поэтому вручную. */
export function originOf(url) {
    try {
        const u = new URL(url);
        return u.protocol === "app:" ? `app://${u.host}` : u.origin;
    } catch {
        return "";
    }
}

/** Сайты, которые можно открыть во внешнем браузере из приложения. */
const EXTERNAL_HOSTS = ["tarkov.dev", "github.com", "escapefromtarkov.fandom.com", "creativecommons.org", "tarkovbot.eu", "tarkov-market.com", "nodejs.org"];

export function openExternalSafe(url) {
    try {
        const u = new URL(url);
        if (u.protocol !== "https:") return false;
        if (!EXTERNAL_HOSTS.some((h) => u.hostname === h || u.hostname.endsWith("." + h))) return false;
        shell.openExternal(u.href);
        return true;
    } catch {
        return false;
    }
}

/** Политика для страниц интерфейса. */
export const CSP = [
    "default-src 'self'",
    // свои скрипты; wasm — для распознавателя текста (Tesseract)
    "script-src 'self' 'wasm-unsafe-eval'",
    "worker-src 'self' blob:",
    // React и Leaflet задают стили элементам
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob: https://assets.tarkov.dev",
    "font-src 'self' data:",
    "media-src 'self' blob: mediastream:",
    // данные и цены — только tarkov.dev
    "connect-src 'self' data: blob: https://json.tarkov.dev https://assets.tarkov.dev https://api.tarkov.dev",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-src 'none'",
    "frame-ancestors 'none'",
].join("; ");

const ALLOWED_PERMISSIONS = new Set(["notifications", "media", "display-capture", "clipboard-sanitized-write"]);

/** @param {{ trustedOrigins: string[] }} o */
export function hardenApp(o) {
    const trusted = (url) => o.trustedOrigins.includes(originOf(url));

    app.on("web-contents-created", (_e, wc) => {
        const block = (ev, url) => {
            if (!trusted(url)) ev.preventDefault();
        };
        wc.on("will-navigate", block);
        wc.on("will-redirect", block);
        wc.on("will-attach-webview", (ev) => ev.preventDefault());
        wc.setWindowOpenHandler(({ url }) => {
            openExternalSafe(url);
            return { action: "deny" };
        });
    });

    session.defaultSession.setPermissionRequestHandler((wc, permission, cb, details) => {
        cb(ALLOWED_PERMISSIONS.has(permission) && trusted(details?.requestingUrl ?? wc.getURL()));
    });
    session.defaultSession.setPermissionCheckHandler((_wc, permission, origin) => ALLOWED_PERMISSIONS.has(permission) && o.trustedOrigins.includes(originOf(origin)));
}
