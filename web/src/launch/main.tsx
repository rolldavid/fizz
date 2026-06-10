// NOTE: /launch deliberately ships ZERO L1 code — no wagmi, no RainbowKit,
// no viem. The page only talks to the Fizz extension.
import React from "react";
import ReactDOM from "react-dom/client";
import "../styles.css";
import { ConnectionProvider } from "../connection";
import { LaunchPage } from "./LaunchPage";

const rootEl = document.getElementById("root");
if (!rootEl) throw new Error("Missing #root element.");

ReactDOM.createRoot(rootEl).render(
    <React.StrictMode>
        <ConnectionProvider>
            <LaunchPage />
        </ConnectionProvider>
    </React.StrictMode>,
);
