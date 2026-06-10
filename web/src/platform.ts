/**
 * Where is this page running, and can the Fizz extension be used here?
 *
 * Fizz is a desktop Chromium browser-extension wallet. It cannot run on mobile
 * browsers (no extension support at all) or — for now — on non-Chromium desktop
 * browsers (Firefox/Safari; a Firefox build is planned). Pages use this to gate
 * wallet-connect actions and steer people to a supported browser instead of
 * letting them hit a dead end.
 */
export type PlatformReason = "ok" | "mobile" | "non-chromium";

export type Platform = {
    isMobile: boolean;
    isChromium: boolean;
    /** Desktop AND Chromium — the only place the extension can be added or used. */
    canUseExtension: boolean;
    reason: PlatformReason;
};

export function detectPlatform(): Platform {
    if (typeof navigator === "undefined") {
        return { isMobile: false, isChromium: true, canUseExtension: true, reason: "ok" };
    }
    const ua = navigator.userAgent;
    const uaData = (navigator as unknown as { userAgentData?: { mobile?: boolean; brands?: { brand: string }[] } })
        .userAgentData;

    // iPadOS 13+ reports as desktop Safari ("Macintosh") but is touch-only.
    const iPadOS =
        /Macintosh/.test(ua) && typeof navigator.maxTouchPoints === "number" && navigator.maxTouchPoints > 1;
    const isMobile =
        uaData?.mobile === true ||
        /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini|Mobile/i.test(ua) ||
        iPadOS;

    // userAgentData.brands is Chromium-only and authoritative when present.
    // UA fallback: has "Chrome/" and is not Firefox or an iOS-WebKit browser
    // (CriOS/FxiOS/EdgiOS all wrap WebKit and can't run these extensions).
    const brandIsChromium =
        Array.isArray(uaData?.brands) &&
        uaData!.brands!.some((b) => /Chromium|Google Chrome|Microsoft Edge/i.test(b.brand));
    const isChromium = brandIsChromium || (/Chrome\//.test(ua) && !/Firefox|FxiOS|CriOS|EdgiOS/i.test(ua));

    const canUseExtension = !isMobile && isChromium;
    const reason: PlatformReason = isMobile ? "mobile" : !isChromium ? "non-chromium" : "ok";
    return { isMobile, isChromium, canUseExtension, reason };
}
