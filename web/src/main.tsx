import React from "react";
import ReactDOM from "react-dom/client";
import "./styles.css";
import { ConnectionProvider } from "./connection";
import { EthProvider } from "./eth/EthProvider";
import { App } from "./App";

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
