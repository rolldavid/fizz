/**
 * In-popup background token deploy.
 *
 * Deploying a token is minutes of client-side proving. Holding that inside the
 * Deploy page's component state held the USER hostage too — leaving the screen
 * orphaned the progress UI, so the page pinned them on a spinner. This module
 * owns the deploy as a singleton task at module level instead: the Deploy page
 * starts it and merely RENDERS it, every other screen stays usable, and the
 * Shell shows a bottom status bar ("Deploying… keep window open") that links
 * back to the live progress.
 *
 * The popup process is still the prover, so the window must stay OPEN — but
 * not stay on one screen. If the popup does die mid-deploy, the existing crash
 * journal (opJournal + DeployRecovery on Home) recovers: the predicted address
 * is journaled before the tx is sent.
 *
 * One deploy at a time. The terminal states ("done"/"failed") persist until
 * the user sees them (clearDeployTask from the Deploy page) so a result can
 * never flash by unseen.
 */

import { useSyncExternalStore } from "react";
import type { AztecAddress } from "@aztec/aztec.js/addresses";
import type { AztecWallet } from "../aztec/wallet";
import type { AztecNetwork } from "../aztec/networks";
import { deployToken } from "../aztec/deploy";
import { addToken } from "../aztec/tokens";
import { clearDeployJournal, recordDeployStart } from "./opJournal";
import { trackOp } from "./activity";

export type DeployTask =
    | {
          phase: "running";
          networkId: AztecNetwork["id"];
          name: string;
          symbol: string;
          decimals: number;
          stage: string;
          startedAt: number;
          /** Deterministic contract address, known once the tx is built. */
          predictedAddress: string | null;
      }
    | {
          phase: "done";
          networkId: AztecNetwork["id"];
          name: string;
          symbol: string;
          address: string;
          txHash: string;
          /** Total actual fee paid across the deploy's txs (fee-juice base units). */
          feeJuice?: bigint;
      }
    | {
          phase: "failed";
          networkId: AztecNetwork["id"];
          name: string;
          symbol: string;
          message: string;
      };

let task: DeployTask | null = null;
const listeners = new Set<() => void>();

function setTask(next: DeployTask | null): void {
    task = next;
    for (const l of [...listeners]) l();
}

export function getDeployTask(): DeployTask | null {
    return task;
}

export function useDeployTask(): DeployTask | null {
    return useSyncExternalStore((cb) => {
        listeners.add(cb);
        return () => listeners.delete(cb);
    }, getDeployTask);
}

/** Acknowledge a finished/failed deploy. No-op while one is running. */
export function clearDeployTask(): void {
    if (task && task.phase === "running") return;
    setTask(null);
}

export function startTokenDeploy(args: {
    wallet: AztecWallet;
    network: AztecNetwork;
    deployer: AztecAddress;
    /** From walletContext — activates the account first when needed. */
    ensureAccountDeployed: () => Promise<void>;
    accountIsDeployed: boolean;
    name: string;
    symbol: string;
    decimals: number;
    initialSupply: bigint;
    initialSupplyMode: "private" | "public";
    keepMinterRole: boolean;
}): void {
    if (task?.phase === "running") {
        throw new Error("A token deploy is already in progress — one at a time.");
    }
    const { name, symbol, decimals } = args;
    const base = { networkId: args.network.id, name, symbol };
    setTask({
        phase: "running",
        ...base,
        decimals,
        stage: "Preparing…",
        startedAt: Date.now(),
        predictedAddress: null,
    });
    const stage = (s: string) => {
        if (task?.phase === "running") setTask({ ...task, stage: s });
    };

    // Fire and track — callers never await this. trackOp defers the idle
    // auto-lock for the whole run (proving easily exceeds the 5-min window).
    void trackOp(async () => {
        if (!args.accountIsDeployed) {
            stage("Activating your account (one-time)…");
            await args.ensureAccountDeployed();
        }
        stage("Proving + publishing the token…");
        const res = await deployToken({
            wallet: args.wallet,
            network: args.network,
            deployer: args.deployer,
            name,
            symbol,
            decimals,
            initialSupply: args.initialSupply,
            initialSupplyMode: args.initialSupplyMode,
            keepMinterRole: args.keepMinterRole,
            // Crash journal: the address is deterministic and known pre-send.
            // If the popup dies mid-flight, the next session probes the chain
            // for it and recovers the token or explains the interruption.
            onPredictedAddress: async (address) => {
                if (task?.phase === "running") setTask({ ...task, predictedAddress: address });
                await recordDeployStart({
                    predictedAddress: address,
                    name,
                    symbol,
                    decimals,
                    networkId: args.network.id,
                    deployer: args.deployer.toString(),
                    hadInitialSupply: args.initialSupply > 0n,
                    startedAt: Date.now(),
                });
            },
        });
        const addrStr = res.address.toString();
        await addToken(args.network.id, args.deployer.toString(), {
            address: addrStr,
            symbol,
            name,
            decimals,
        });
        await clearDeployJournal();
        setTask({ phase: "done", ...base, address: addrStr, txHash: res.txHash, feeJuice: res.feeJuice });
    }).catch(async (e) => {
        // The failure is shown in the status bar + Deploy page — the journal
        // would only produce a stale "interrupted" banner next session. Keep
        // the FULL error (stack and all) in the console: the UI only carries
        // the message, which for deep SDK failures can be a bare TypeError.
        console.error("Token deploy failed:", e);
        await clearDeployJournal();
        setTask({
            phase: "failed",
            ...base,
            message: e instanceof Error ? e.message : String(e),
        });
    });
}
