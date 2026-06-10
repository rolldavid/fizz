import React from "react";
import ReactDOM from "react-dom/client";
import "@rainbow-me/rainbowkit/styles.css";
import "../styles.css";
import { darkTheme, getDefaultConfig, RainbowKitProvider } from "@rainbow-me/rainbowkit";
import { WagmiProvider, http } from "wagmi";
import { sepolia } from "wagmi/chains";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { SEPOLIA_RPC_URL, WALLETCONNECT_PROJECT_ID } from "../config";
import { BridgePage } from "./BridgePage";

// WALLETCONNECT_PROJECT_ID may be the "FIZZ_WC_PROJECT_ID" placeholder —
// injected wallets still work; see src/config.ts and web/README.md.
const wagmiConfig = getDefaultConfig({
    appName: "Fizz — bridge fee juice",
    projectId: WALLETCONNECT_PROJECT_ID,
    chains: [sepolia],
    transports: { [sepolia.id]: http(SEPOLIA_RPC_URL) },
});

const queryClient = new QueryClient();

const rootEl = document.getElementById("root");
if (!rootEl) throw new Error("Missing #root element.");

ReactDOM.createRoot(rootEl).render(
    <React.StrictMode>
        <WagmiProvider config={wagmiConfig}>
            <QueryClientProvider client={queryClient}>
                <RainbowKitProvider
                    theme={darkTheme({
                        accentColor: "#FF5C94",
                        accentColorForeground: "#ffffff",
                        borderRadius: "large",
                    })}
                >
                    <BridgePage />
                </RainbowKitProvider>
            </QueryClientProvider>
        </WagmiProvider>
    </React.StrictMode>,
);
