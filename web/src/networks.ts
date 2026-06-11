/**
 * Bridge networks. Mainnet is the real bridge (AZTEC token on Ethereum L1).
 * Testnet (Sepolia) is a free PRACTICE mode: the exact same FeeJuicePortal
 * deposit, but the FEE asset can be free-minted via the node's FeeAssetHandler,
 * so you can rehearse the whole flow end-to-end at no cost.
 *
 * Switch the Fizz wallet to the matching network too — the fee juice lands on
 * whichever account the wallet hands back during the bridge handshake.
 */
import { mainnet, sepolia } from "wagmi/chains";
import type { Chain } from "viem";

export type NetId = "mainnet" | "testnet";

export type BridgeNetwork = {
    id: NetId;
    label: string;
    aztecNodeUrl: string;
    l1: Chain;
    l1RpcUrl: string;
    /**
     * Pinned L1 fee contracts, enforced before any approve/deposit (real funds).
     * null on testnet: it redeploys and carries no value, so we trust the node's
     * node-info there.
     */
    pin: { feeJuicePortalAddress: string; feeJuiceAddress: string } | null;
};

export const BRIDGE_NETWORKS: Record<NetId, BridgeNetwork> = {
    mainnet: {
        id: "mainnet",
        label: "Mainnet",
        aztecNodeUrl: "https://lb.drpc.live/aztec-mainnet/AsSP5jeGMUnUmdsy88mWgdsyXG-SZcwR8ZfEVjewFaCJ",
        l1: mainnet,
        l1RpcUrl: "https://lb.drpc.live/ethereum/AsSP5jeGMUnUmdsy88mWgdsyXG-SZcwR8ZfEVjewFaCJ",
        pin: {
            feeJuicePortalAddress: "0x2891f8b941067f8b5a3f34545a30cf71e3e23617",
            feeJuiceAddress: "0xa27ec0006e59f245217ff08cd52a7e8b169e62d2",
        },
    },
    testnet: {
        id: "testnet",
        label: "Testnet",
        aztecNodeUrl: "https://rpc.testnet.aztec-labs.com",
        l1: sepolia,
        l1RpcUrl: "https://lb.drpc.live/sepolia/AsSP5jeGMUnUmdsy88mWgdsyXG-SZcwR8ZfEVjewFaCJ",
        pin: null,
    },
};
