import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";

/**
 * Stale-build self-healing. Rebuilding `dist/` while a popup is open leaves
 * that popup referencing hashed chunks that no longer exist on disk; the next
 * lazy import then dies with "Failed to fetch dynamically imported module"
 * (observed repeatedly in dev: sends and deploys breaking after a rebuild).
 * Vite fires `vite:preloadError` for exactly this, and unpacked extension
 * pages serve files straight from disk — so one reload of the POPUP picks up
 * the new build, no chrome://extensions visit needed. Loop-guarded: at most
 * one auto-reload per minute; a genuinely broken build surfaces normally.
 */
const RELOAD_GUARD_KEY = "fizz.staleChunkReloadAt";
window.addEventListener("vite:preloadError", (event) => {
    const last = Number(sessionStorage.getItem(RELOAD_GUARD_KEY) ?? 0);
    if (Date.now() - last < 60_000) return; // don't loop on a broken build
    sessionStorage.setItem(RELOAD_GUARD_KEY, String(Date.now()));
    event.preventDefault();
    window.location.reload();
});

createRoot(document.getElementById("root")!).render(
    <StrictMode>
        <App />
    </StrictMode>,
);
