import React from "react";
import ReactDOM from "react-dom/client";
import "./styles.css";
import { ConnectionProvider } from "./connection";
import { EthProvider } from "./eth/EthProvider";
import { App } from "./App";

// Recover from stale lazy-chunk loads. The tool pages (/bridge, /launch) are
// code-split, so a tab that was open across a redeploy — or one booted from a
// cached index.html — holds references to hashed chunks the new deploy has
// already replaced. Importing one then 404s with "Failed to fetch dynamically
// imported module". Vite raises `vite:preloadError` for exactly this; reload
// once to pull the current index.html + chunks. The sessionStorage guard caps
// it at one reload per short window so a genuinely-missing chunk can't loop.
window.addEventListener("vite:preloadError", (event) => {
    const KEY = "fizz.chunkReloadAt";
    const last = Number(sessionStorage.getItem(KEY) || "0");
    if (Date.now() - last < 15_000) return; // already reloaded just now — let it surface
    event.preventDefault();
    sessionStorage.setItem(KEY, String(Date.now()));
    window.location.reload();
});

// Providers wrap the router so BOTH wallet connections (Aztec + Ethereum) are
// site-wide and survive client-side navigation. The Ethereum (wagmi) code is
// pulled in lazily by EthProvider — it's not in this entry chunk.
const rootEl = document.getElementById("root");
if (!rootEl) throw new Error("Missing #root element.");

ReactDOM.createRoot(rootEl).render(
    <React.StrictMode>
        <ConnectionProvider>
            <EthProvider>
                <App />
            </EthProvider>
        </ConnectionProvider>
    </React.StrictMode>,
);
