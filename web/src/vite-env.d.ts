/// <reference types="vite/client" />

interface ImportMetaEnv {
    /**
     * WalletConnect Cloud project id for the /bridge page. Without a real one
     * the page still works with injected wallets (MetaMask, Rabby, …) but the
     * WalletConnect QR option will not connect. Get one free at
     * https://cloud.walletconnect.com and build with
     * `VITE_WALLETCONNECT_PROJECT_ID=... yarn build`.
     */
    readonly VITE_WALLETCONNECT_PROJECT_ID?: string;
}

interface ImportMeta {
    readonly env: ImportMetaEnv;
}
