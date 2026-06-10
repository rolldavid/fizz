import { useEffect, useRef, useState } from "react";
import { ConnectButton } from "@rainbow-me/rainbowkit";
import { useAccount, useConfig } from "wagmi";
import { sepolia } from "wagmi/chains";
import {
    getAccount,
    readContract,
    simulateContract,
    switchChain,
    waitForTransactionReceipt,
    writeContract,
} from "wagmi/actions";
import { formatUnits, parseEventLogs, parseUnits } from "viem";
import { Shell, ErrorBox, CopyButton, shortHex } from "../components";
import { AZTEC_NETWORK_ID, AZTEC_NODE_URL, CHROME_STORE_URL, GITHUB_URL } from "../config";
import { fetchNodeInfo, type AztecNodeInfo, type Hex } from "../nodeInfo";
import { encodeClaimTicket, type ClaimTicket } from "../claimTicket";
import { pingFizz, sendToFizz, type ConnectPending, type ConnectStatus } from "../extension";
import { feeAssetAbi, feeAssetHandlerAbi, feeJuicePortalAbi } from "./abi";
import { generateClaimSecretPair, type ClaimSecretPair } from "./secret";
import { createRecord, listRecords, removeRecord, updateRecord, type PendingRecord } from "./pending";

/** Shape guard for the address Fizz grants — the page's only recipient source. */
const AZTEC_ADDRESS_RE = /^0x[0-9a-fA-F]{64}$/;
const lower = (h: string) => h.toLowerCase();

const CONNECT_POLL_MS = 2000;
const CONNECT_TIMEOUT_MS = 120_000;

type NodeState =
    | { status: "loading" }
    | { status: "error"; message: string }
    | { status: "ready"; info: AztecNodeInfo };

type AssetState =
    | { status: "loading" }
    | { status: "error"; message: string }
    | { status: "ready"; symbol: string; decimals: number; mintAmount: bigint | null };

type BalanceState =
    | { status: "idle" }
    | { status: "loading" }
    | { status: "error"; message: string }
    | { status: "ready"; value: bigint };

/**
 * Fizz connection state machine. The bridge deposits ONLY into the connected
 * Fizz wallet — there is no manual recipient — so connecting is step 1.
 */
type FizzConn =
    | { status: "detecting" }
    | { status: "absent" }
    | { status: "idle" }
    | { status: "connecting" }
    | { status: "waiting"; since: number; note: string | null }
    | { status: "denied" }
    | { status: "timeout" }
    | { status: "error"; message: string }
    | { status: "connected"; address: string; networkId: string };

type StepId = "secret" | "mint" | "approve" | "deposit";
type StepStatus = "todo" | "active" | "done" | "failed";

type Handoff = { state: "sent" } | { state: "manual"; reason: string };

type Outcome = {
    encoded: string;
    recordId: string;
    recipient: string;
    amount: bigint;
    l1TxHash: Hex;
    handoff: Handoff;
};

/** Mutable flow progress so a Retry resumes instead of redoing (and never regenerates the secret). */
type Progress = {
    secretPair?: ClaimSecretPair;
    recordId?: string;
    /** Connected Fizz address, locked at first run — a mid-flow reconnect must not divert a retry. */
    recipient?: string;
    amount?: bigint;
    mintDone: boolean;
    approveDone: boolean;
    depositHash?: Hex;
};

const freshProgress = (): Progress => ({ mintDone: false, approveDone: false });
const ALL_TODO: Record<StepId, StepStatus> = { secret: "todo", mint: "todo", approve: "todo", deposit: "todo" };

function errMessage(err: unknown): string {
    return err instanceof Error ? err.message : String(err);
}

function ticketFromRecord(r: PendingRecord): string {
    if (r.status !== "deposited" || !r.messageHash || !r.messageLeafIndex || !r.l1TxHash) {
        throw new Error("Record is not ticket-complete.");
    }
    const ticket: ClaimTicket = {
        v: 1,
        kind: "fee-juice-claim",
        networkId: r.networkId,
        l1ChainId: r.l1ChainId,
        recipient: r.recipient,
        claimAmount: r.amount,
        claimSecret: r.claimSecret,
        messageHash: r.messageHash,
        messageLeafIndex: r.messageLeafIndex,
        l1TxHash: r.l1TxHash,
        createdAt: r.createdAt,
    };
    return encodeClaimTicket(ticket);
}

export function BridgePage() {
    const config = useConfig();
    const { address: account, isConnected } = useAccount();

    const [node, setNode] = useState<NodeState>({ status: "loading" });
    const [asset, setAsset] = useState<AssetState>({ status: "loading" });
    const [balance, setBalance] = useState<BalanceState>({ status: "idle" });

    const [fizz, setFizz] = useState<FizzConn>({ status: "detecting" });
    const connectTimer = useRef<number | null>(null);
    /** Bumped on every (re)connect/stop so in-flight polls from a stale attempt are ignored. */
    const connectGen = useRef(0);

    const [mode, setMode] = useState<"mint" | "balance">("mint");
    const [amountInput, setAmountInput] = useState("");

    const [running, setRunning] = useState(false);
    const [stepStatus, setStepStatus] = useState<Record<StepId, StepStatus>>(ALL_TODO);
    const [flowError, setFlowError] = useState<string | null>(null);
    const [outcome, setOutcome] = useState<Outcome | null>(null);
    const progress = useRef<Progress>(freshProgress());

    const [records, setRecords] = useState<PendingRecord[]>([]);
    const [recordNotice, setRecordNotice] = useState<{ id: string; text: string } | null>(null);

    // ── data loading ────────────────────────────────────────────────────────
    const loadNode = () => {
        setNode({ status: "loading" });
        fetchNodeInfo()
            .then((info) => setNode({ status: "ready", info }))
            .catch((err) => setNode({ status: "error", message: errMessage(err) }));
    };
    useEffect(loadNode, []);

    useEffect(() => {
        try {
            setRecords(listRecords());
        } catch (err) {
            // A corrupted ledger must be visible, not blanked over.
            setFlowError(errMessage(err));
        }
    }, []);

    useEffect(() => {
        if (node.status !== "ready") return;
        const { feeJuiceAddress, feeAssetHandlerAddress } = node.info;
        let cancelled = false;
        setAsset({ status: "loading" });
        (async () => {
            const [symbol, decimals] = await Promise.all([
                readContract(config, { abi: feeAssetAbi, address: feeJuiceAddress, functionName: "symbol", chainId: sepolia.id }),
                readContract(config, { abi: feeAssetAbi, address: feeJuiceAddress, functionName: "decimals", chainId: sepolia.id }),
            ]);
            const mintAmount = feeAssetHandlerAddress
                ? await readContract(config, {
                      abi: feeAssetHandlerAbi,
                      address: feeAssetHandlerAddress,
                      functionName: "mintAmount",
                      chainId: sepolia.id,
                  })
                : null;
            if (!cancelled) setAsset({ status: "ready", symbol, decimals, mintAmount });
        })().catch((err) => {
            if (!cancelled) setAsset({ status: "error", message: errMessage(err) });
        });
        return () => {
            cancelled = true;
        };
    }, [config, node]);

    useEffect(() => {
        if (node.status !== "ready" || !account) {
            setBalance({ status: "idle" });
            return;
        }
        let cancelled = false;
        setBalance({ status: "loading" });
        readContract(config, {
            abi: feeAssetAbi,
            address: node.info.feeJuiceAddress,
            functionName: "balanceOf",
            args: [account],
            chainId: sepolia.id,
        })
            .then((value) => {
                if (!cancelled) setBalance({ status: "ready", value });
            })
            .catch((err) => {
                if (!cancelled) setBalance({ status: "error", message: errMessage(err) });
            });
        return () => {
            cancelled = true;
        };
    }, [config, node, account, outcome]);

    // ── Fizz connection (the ONLY recipient — no manual entry) ─────────────
    useEffect(() => {
        let cancelled = false;
        void pingFizz().then((present) => {
            if (!cancelled) setFizz(present ? { status: "idle" } : { status: "absent" });
        });
        return () => {
            cancelled = true;
        };
    }, []);

    function stopConnectPolling() {
        connectGen.current += 1;
        if (connectTimer.current !== null) {
            window.clearInterval(connectTimer.current);
            connectTimer.current = null;
        }
    }
    useEffect(() => stopConnectPolling, []);

    function startConnectPolling(since: number) {
        const gen = connectGen.current;
        connectTimer.current = window.setInterval(() => {
            void (async () => {
                if (connectGen.current !== gen) return;
                if (Date.now() - since > CONNECT_TIMEOUT_MS) {
                    stopConnectPolling();
                    setFizz({ status: "timeout" });
                    return;
                }
                try {
                    const res = await sendToFizz<ConnectStatus>({ type: "fizz:connect-status" });
                    if (connectGen.current !== gen) return;
                    if (!res.ok) {
                        stopConnectPolling();
                        setFizz({ status: "error", message: res.error ?? "Fizz refused the connection status check." });
                        return;
                    }
                    if (res.granted === true) {
                        stopConnectPolling();
                        // The granted address is the deposit recipient — malformed data
                        // must fail loudly here, not at L1 simulation time.
                        if (typeof res.address !== "string" || !AZTEC_ADDRESS_RE.test(res.address)) {
                            setFizz({
                                status: "error",
                                message: `Fizz granted the connection but returned a malformed address: ${String(res.address)}`,
                            });
                            return;
                        }
                        if (typeof res.networkId !== "string" || res.networkId === "") {
                            setFizz({ status: "error", message: "Fizz granted the connection but returned no network id." });
                            return;
                        }
                        setFizz({ status: "connected", address: res.address, networkId: res.networkId });
                        return;
                    }
                    if (res.denied === true) {
                        stopConnectPolling();
                        setFizz({ status: "denied" });
                        return;
                    }
                    // granted:false with no denial — the user hasn't decided yet; keep polling.
                } catch (err) {
                    if (connectGen.current !== gen) return;
                    // Transient messaging hiccup (service worker waking) — surface it and
                    // keep polling; the 2-minute deadline above bounds this.
                    const note = errMessage(err);
                    setFizz((cur) => (cur.status === "waiting" ? { ...cur, note } : cur));
                }
            })();
        }, CONNECT_POLL_MS);
    }

    async function connectFizz() {
        stopConnectPolling();
        setFizz({ status: "connecting" });
        try {
            const res = await sendToFizz<ConnectPending>({ type: "fizz:connect" });
            if (!res.ok) throw new Error(res.error ?? "Fizz refused the connection request.");
            if (res.pending !== true) {
                throw new Error("Unexpected reply from Fizz — expected a pending approval window.");
            }
            const since = Date.now();
            setFizz({ status: "waiting", since, note: null });
            startConnectPolling(since);
        } catch (err) {
            stopConnectPolling();
            setFizz({ status: "error", message: errMessage(err) });
        }
    }

    // When there is no faucet handler, minting is impossible.
    const mintAvailable = asset.status === "ready" && asset.mintAmount !== null;
    useEffect(() => {
        if (asset.status === "ready" && asset.mintAmount === null && mode === "mint") setMode("balance");
    }, [asset, mode]);

    // ── derived form validity ───────────────────────────────────────────────
    const decimals = asset.status === "ready" ? asset.decimals : 18;
    const symbol = asset.status === "ready" ? asset.symbol : "fee asset";
    const fmt = (v: bigint) => formatUnits(v, decimals);

    /** Connected AND on the network this bridge targets — the only state deposits are allowed in. */
    const fizzReady = fizz.status === "connected" && fizz.networkId === AZTEC_NETWORK_ID;
    const amountValid =
        mode === "mint" ||
        (/^\d+(\.\d+)?$/.test(amountInput.trim()) && balance.status === "ready");

    const flowLocked = progress.current.secretPair !== undefined && outcome === null;
    const canStart =
        !running &&
        outcome === null &&
        isConnected &&
        node.status === "ready" &&
        asset.status === "ready" &&
        fizzReady &&
        amountValid;

    const steps: { id: StepId; label: string; note?: string }[] = [
        {
            id: "secret",
            label: "Generate & save the claim secret",
            note: "stored in this browser before any transaction — fund safety",
        },
        ...(mode === "mint"
            ? [
                  {
                      id: "mint" as StepId,
                      label: `Mint ${asset.status === "ready" && asset.mintAmount !== null ? fmt(asset.mintAmount) : "…"} ${symbol} (free, testnet)`,
                  },
              ]
            : []),
        { id: "approve", label: "Approve the portal to pull the fee asset" },
        { id: "deposit", label: "Deposit to Aztec — one-way, L1 → L2" },
    ];

    function setStep(id: StepId, status: StepStatus) {
        setStepStatus((prev) => ({ ...prev, [id]: status }));
    }

    // ── the flow ────────────────────────────────────────────────────────────
    async function run() {
        if (node.status !== "ready" || asset.status !== "ready") return;
        const info = node.info;
        const meta = asset;
        setFlowError(null);
        setRunning(true);
        let active: StepId = "secret";
        try {
            const acct = getAccount(config);
            if (!acct.address) throw new Error("Connect an Ethereum wallet first.");
            if (fizz.status !== "connected") {
                throw new Error("Connect your Fizz wallet first — the bridge deposits only into the connected account.");
            }
            if (fizz.networkId !== AZTEC_NETWORK_ID) {
                throw new Error("Switch Fizz to Aztec Testnet (network picker, top of the wallet), then reconnect.");
            }
            if (info.l1ChainId !== sepolia.id) {
                throw new Error(
                    `The Aztec node reports L1 chain ${info.l1ChainId}, but this page only supports Sepolia (${sepolia.id}).`,
                );
            }
            if (acct.chainId !== sepolia.id) {
                await switchChain(config, { chainId: sepolia.id });
            }

            // Lock the recipient (= the connected Fizz account) on first run so a
            // reconnect can't point a retry away from the already-saved claim record.
            if (progress.current.recipient === undefined) {
                progress.current.recipient = fizz.address;
            }
            const recipient = progress.current.recipient;

            // Lock the amount on first run so retries can't drift.
            if (progress.current.amount === undefined) {
                if (mode === "mint") {
                    if (meta.mintAmount === null) {
                        throw new Error("This network has no free fee-asset handler — bridge your own balance instead.");
                    }
                    progress.current.amount = meta.mintAmount;
                } else {
                    if (balance.status !== "ready") throw new Error("Your fee-asset balance has not loaded yet.");
                    const parsed = parseUnits(amountInput.trim(), meta.decimals);
                    if (parsed <= 0n) throw new Error("Amount must be greater than zero.");
                    if (parsed > balance.value) {
                        throw new Error(`Amount exceeds your balance of ${fmt(balance.value)} ${meta.symbol}.`);
                    }
                    progress.current.amount = parsed;
                }
            }
            const amount = progress.current.amount;

            // 1 — claim secret, persisted BEFORE any L1 transaction.
            active = "secret";
            setStep("secret", "active");
            if (!progress.current.secretPair) {
                const pair = await generateClaimSecretPair();
                const record = createRecord({
                    networkId: AZTEC_NETWORK_ID,
                    l1ChainId: sepolia.id,
                    recipient,
                    amount: amount.toString(),
                    claimSecret: pair.secret,
                    claimSecretHash: pair.secretHash,
                });
                progress.current.secretPair = pair;
                progress.current.recordId = record.id;
                setRecords(listRecords());
            }
            const { secretHash } = progress.current.secretPair;
            const recordId = progress.current.recordId;
            if (!recordId) throw new Error("Internal: claim record id missing.");
            setStep("secret", "done");

            // 2 — optional free mint (testnet handler mints a FIXED batch).
            if (mode === "mint" && !progress.current.mintDone) {
                active = "mint";
                setStep("mint", "active");
                if (!info.feeAssetHandlerAddress) {
                    throw new Error("The node reports no fee-asset handler address.");
                }
                const mintHash = await writeContract(config, {
                    abi: feeAssetHandlerAbi,
                    address: info.feeAssetHandlerAddress,
                    functionName: "mint",
                    args: [acct.address],
                    chainId: sepolia.id,
                });
                const mintReceipt = await waitForTransactionReceipt(config, { hash: mintHash, chainId: sepolia.id });
                if (mintReceipt.status !== "success") {
                    throw new Error(`Mint transaction reverted on L1 (${mintHash}).`);
                }
                progress.current.mintDone = true;
            }
            if (mode === "mint") setStep("mint", "done");

            // 3 — approve the portal.
            if (!progress.current.approveDone) {
                active = "approve";
                setStep("approve", "active");
                const approveHash = await writeContract(config, {
                    abi: feeAssetAbi,
                    address: info.feeJuiceAddress,
                    functionName: "approve",
                    args: [info.feeJuicePortalAddress, amount],
                    chainId: sepolia.id,
                });
                const approveReceipt = await waitForTransactionReceipt(config, { hash: approveHash, chainId: sepolia.id });
                if (approveReceipt.status !== "success") {
                    throw new Error(`Approve transaction reverted on L1 (${approveHash}).`);
                }
                progress.current.approveDone = true;
            }
            setStep("approve", "done");

            // 4 — the deposit itself (simulated first to surface reverts early).
            active = "deposit";
            setStep("deposit", "active");
            let depositHash = progress.current.depositHash;
            if (!depositHash) {
                const sim = await simulateContract(config, {
                    abi: feeJuicePortalAbi,
                    address: info.feeJuicePortalAddress,
                    functionName: "depositToAztecPublic",
                    args: [recipient as Hex, amount, secretHash],
                    account: acct.address,
                    chainId: sepolia.id,
                });
                depositHash = await writeContract(config, sim.request);
                progress.current.depositHash = depositHash;
                updateRecord(recordId, { l1TxHash: depositHash });
                setRecords(listRecords());
            }
            const receipt = await waitForTransactionReceipt(config, { hash: depositHash, chainId: sepolia.id });
            if (receipt.status !== "success") {
                // A reverted deposit moved nothing; a retry must send a NEW deposit.
                progress.current.depositHash = undefined;
                throw new Error(`Deposit transaction reverted on L1 (${depositHash}). Nothing was bridged — retry is safe.`);
            }

            const events = parseEventLogs({
                abi: feeJuicePortalAbi,
                logs: receipt.logs,
                eventName: "DepositToAztecPublic",
            });
            const match = events.find(
                (log) =>
                    lower(log.address) === lower(info.feeJuicePortalAddress) &&
                    lower(log.args.secretHash) === lower(secretHash),
            );
            if (!match) {
                throw new Error(
                    "Deposit mined but its DepositToAztecPublic event was not found — refusing to build an unverifiable claim ticket. " +
                        "Your claim secret is saved below; keep it.",
                );
            }
            const updated = updateRecord(recordId, {
                status: "deposited",
                messageHash: match.args.key,
                messageLeafIndex: match.args.index.toString(),
            });
            setRecords(listRecords());
            const encoded = ticketFromRecord(updated);
            setStep("deposit", "done");

            // 5 — hand the ticket to the extension; manual copy is ALWAYS shown too.
            let handoff: Handoff;
            try {
                const res = await sendToFizz<{ ok: boolean; error?: string }>({
                    type: "fizz:claim-ticket",
                    ticket: encoded,
                });
                handoff = res.ok
                    ? { state: "sent" }
                    : { state: "manual", reason: res.error ?? "The extension rejected the ticket." };
            } catch (err) {
                handoff = { state: "manual", reason: errMessage(err) };
            }
            setOutcome({
                encoded,
                recordId,
                recipient,
                amount,
                l1TxHash: depositHash,
                handoff,
            });
        } catch (err) {
            setStep(active, "failed");
            setFlowError(errMessage(err));
        } finally {
            setRunning(false);
        }
    }

    function resetFlow() {
        progress.current = freshProgress();
        setStepStatus(ALL_TODO);
        setFlowError(null);
        setOutcome(null);
    }

    async function sendRecordToFizz(r: PendingRecord) {
        try {
            const res = await sendToFizz<{ ok: boolean; error?: string }>({
                type: "fizz:claim-ticket",
                ticket: ticketFromRecord(r),
            });
            setRecordNotice({
                id: r.id,
                text: res.ok ? "Sent to Fizz ✓" : `Fizz refused it: ${res.error ?? "unknown error"}`,
            });
        } catch (err) {
            setRecordNotice({ id: r.id, text: errMessage(err) });
        }
    }

    const earlierRecords = records.filter((r) => r.id !== outcome?.recordId && r.id !== progress.current.recordId);

    // ── render ──────────────────────────────────────────────────────────────
    const fizzRetryButton = (
        <div className="row-actions">
            <button type="button" className="btn btn-primary" onClick={() => void connectFizz()}>
                Retry — connect Fizz wallet
            </button>
        </div>
    );

    return (
        <Shell page="bridge">
            <section className="page-hero">
                <span className="pill">Testnet · Sepolia → Aztec</span>
                <h1>
                    Get <em>fee juice</em> (gas) on Aztec
                </h1>
                <p className="sub">
                    Bridge the L1 fee asset from Ethereum Sepolia into fee juice on Aztec — from your own
                    Ethereum wallet, straight into your connected Fizz wallet. Fee juice only, one-way only:
                    both are Aztec protocol rules, not ours.
                </p>
            </section>

            <section className="card">
                <div className="card-head">
                    <h2>Bridge</h2>
                    {fizz.status === "detecting" && <span className="muted small">Looking for Fizz…</span>}
                    {fizz.status !== "detecting" && fizz.status !== "absent" && <ConnectButton showBalance={false} />}
                </div>

                {fizz.status === "absent" && (
                    <div className="note-box">
                        <strong>The Fizz extension is required:</strong> the bridge deposits straight into your
                        Fizz wallet — there is no other recipient.{" "}
                        <a href={CHROME_STORE_URL} target="_blank" rel="noopener noreferrer">
                            Get Fizz on the Chrome Web Store
                        </a>{" "}
                        (listing coming soon) or build it from{" "}
                        <a href={GITHUB_URL} target="_blank" rel="noopener noreferrer">
                            github.com/rolldavid/fizz
                        </a>
                        , then reload this page.
                    </div>
                )}

                {fizz.status !== "detecting" && fizz.status !== "absent" && (
                    <>
                        {fizz.status === "idle" && (
                            <div className="note-box">
                                <strong>Step 1 — connect your Fizz wallet.</strong> The bridge deposits straight
                                into your Fizz account; approving shares only that account's address with this
                                page — no keys, no balances.
                                <div className="row-actions">
                                    <button type="button" className="btn btn-primary" onClick={() => void connectFizz()}>
                                        Connect Fizz wallet
                                    </button>
                                </div>
                            </div>
                        )}
                        {fizz.status === "connecting" && (
                            <div className="note-box">
                                <span className="spin">Asking Fizz to open its approval window…</span>
                            </div>
                        )}
                        {fizz.status === "waiting" && (
                            <div className="note-box">
                                <span className="spin">Approve in the Fizz window…</span> it opened as a separate
                                small window. Pick the account the fee juice should land in.
                                {fizz.note !== null && (
                                    <>
                                        <br />
                                        <span className="small">last check: {fizz.note}</span>
                                    </>
                                )}
                            </div>
                        )}
                        {fizz.status === "denied" && (
                            <>
                                <ErrorBox title="Connection denied in Fizz.">
                                    The bridge can only deposit into a connected Fizz account, so it needs your
                                    approval to proceed.
                                </ErrorBox>
                                {fizzRetryButton}
                            </>
                        )}
                        {fizz.status === "timeout" && (
                            <>
                                <ErrorBox title="No decision after 2 minutes">
                                    Fizz never reported an approval — the window may have been closed. Retry to
                                    open a fresh approval window.
                                </ErrorBox>
                                {fizzRetryButton}
                            </>
                        )}
                        {fizz.status === "error" && (
                            <>
                                <ErrorBox title="Could not connect to Fizz">{fizz.message}</ErrorBox>
                                {fizzRetryButton}
                            </>
                        )}
                        {fizz.status === "connected" && fizz.networkId === AZTEC_NETWORK_ID && (
                            <div className="ok-box">
                                <strong>✓ Fizz connected.</strong> Bridging into your Fizz account{" "}
                                <code title={fizz.address}>{shortHex(fizz.address)}</code>
                                <br />
                                <span className="muted small">
                                    Wrong account? Switch accounts in Fizz, then reconnect.
                                </span>{" "}
                                <button
                                    type="button"
                                    className="btn btn-ghost btn-small"
                                    disabled={flowLocked || running}
                                    onClick={() => void connectFizz()}
                                >
                                    Reconnect
                                </button>
                            </div>
                        )}
                        {fizz.status === "connected" && fizz.networkId !== AZTEC_NETWORK_ID && (
                            <>
                                <ErrorBox title={`Fizz is on "${fizz.networkId}" — this bridge targets Aztec Testnet`}>
                                    Switch Fizz to Aztec Testnet (network picker, top of the wallet), then
                                    reconnect. Deposits are blocked until the networks match.
                                </ErrorBox>
                                {fizzRetryButton}
                            </>
                        )}

                        {node.status === "loading" && <p className="hint">Fetching canonical addresses from the Aztec testnet node…</p>}
                        {node.status === "error" && (
                            <>
                                <ErrorBox title="Could not reach the Aztec testnet node">{node.message}</ErrorBox>
                                <button type="button" className="btn btn-ghost btn-small" onClick={loadNode}>
                                    Retry
                                </button>
                            </>
                        )}
                        {asset.status === "error" && (
                            <ErrorBox title="Could not read the L1 fee asset">{asset.message}</ErrorBox>
                        )}

                        {node.status === "ready" && asset.status === "ready" && fizzReady && (
                            <>
                                {!isConnected && (
                                    <p className="hint">
                                        Now connect an Ethereum wallet on Sepolia — it pays for the L1 deposit;
                                        the fee juice itself lands in your connected Fizz account above.
                                    </p>
                                )}

                                <div className="field">
                                    <label>Where does the fee asset come from?</label>
                                    <div className="choice-list">
                                        {mintAvailable && asset.mintAmount !== null && (
                                            <label className={`choice${mode === "mint" ? " selected" : ""}`}>
                                                <input
                                                    type="radio"
                                                    name="mode"
                                                    checked={mode === "mint"}
                                                    onChange={() => setMode("mint")}
                                                    disabled={flowLocked || running}
                                                />
                                                <span>
                                                    <span className="choice-title">
                                                        Get {fmt(asset.mintAmount)} {symbol} free
                                                    </span>
                                                    <br />
                                                    <span className="choice-desc">
                                                        The testnet handler mints a fixed batch (exactly{" "}
                                                        {fmt(asset.mintAmount)}) to your wallet, then we bridge it.
                                                    </span>
                                                </span>
                                            </label>
                                        )}
                                        <label className={`choice${mode === "balance" ? " selected" : ""}`}>
                                            <input
                                                type="radio"
                                                name="mode"
                                                checked={mode === "balance"}
                                                onChange={() => setMode("balance")}
                                                disabled={flowLocked || running}
                                            />
                                            <span>
                                                <span className="choice-title">Bridge my existing {symbol}</span>
                                                <br />
                                                <span className="choice-desc">
                                                    {balance.status === "ready" && `Your balance: ${fmt(balance.value)} ${symbol}.`}
                                                    {balance.status === "loading" && "Loading your balance…"}
                                                    {balance.status === "idle" && "Connect a wallet to see your balance."}
                                                    {balance.status === "error" && `Balance lookup failed: ${balance.message}`}
                                                </span>
                                            </span>
                                        </label>
                                    </div>
                                </div>

                                {mode === "balance" && (
                                    <div className="field">
                                        <label htmlFor="amount">Amount ({symbol})</label>
                                        <input
                                            id="amount"
                                            type="text"
                                            inputMode="decimal"
                                            placeholder={balance.status === "ready" ? fmt(balance.value) : "0"}
                                            value={amountInput}
                                            onChange={(e) => setAmountInput(e.target.value)}
                                            disabled={flowLocked || running}
                                            spellCheck={false}
                                            autoComplete="off"
                                        />
                                        {balance.status === "ready" && (
                                            <p className="sub-label">
                                                <button
                                                    type="button"
                                                    className="btn btn-ghost btn-small"
                                                    disabled={flowLocked || running}
                                                    onClick={() => setAmountInput(fmt(balance.value))}
                                                >
                                                    Use full balance
                                                </button>
                                            </p>
                                        )}
                                    </div>
                                )}

                                {outcome === null && (
                                    <div className="row-actions">
                                        <button type="button" className="btn btn-primary" disabled={!canStart && !flowError} onClick={() => void run()}>
                                            {running ? <span className="spin">Bridging…</span> : flowError ? "Retry" : "Bridge to Aztec"}
                                        </button>
                                        {flowError !== null && !running && (
                                            <button type="button" className="btn btn-ghost" onClick={resetFlow}>
                                                Cancel
                                            </button>
                                        )}
                                    </div>
                                )}

                                {(running || flowError !== null || outcome !== null) && (
                                    <ol className="steps">
                                        {steps.map((s) => (
                                            <li key={s.id} className={stepStatus[s.id]}>
                                                <span className="marker">
                                                    {stepStatus[s.id] === "done" && "✓"}
                                                    {stepStatus[s.id] === "active" && "●"}
                                                    {stepStatus[s.id] === "failed" && "✗"}
                                                    {stepStatus[s.id] === "todo" && "○"}
                                                </span>
                                                <span>
                                                    {s.label}
                                                    {s.note && (
                                                        <>
                                                            {" "}
                                                            <span className="step-note">— {s.note}</span>
                                                        </>
                                                    )}
                                                </span>
                                            </li>
                                        ))}
                                    </ol>
                                )}

                                {flowError !== null && <ErrorBox title="Bridge step failed">{flowError}</ErrorBox>}

                                {outcome !== null && (
                                    <>
                                        <div className="ok-box">
                                            <strong>
                                                Bridged {fmt(outcome.amount)} {symbol} →{" "}
                                                <span title={outcome.recipient}>{shortHex(outcome.recipient)}</span> 🫧
                                            </strong>
                                            <br />
                                            {outcome.handoff.state === "sent" ? (
                                                <>✓ Sent to your Fizz wallet — it auto-pays your next transaction once the message lands on L2 (a few minutes).</>
                                            ) : (
                                                <span>
                                                    Could not hand the ticket to the Fizz extension ({outcome.handoff.reason}) — use the
                                                    copy-paste ticket below instead.
                                                </span>
                                            )}
                                        </div>
                                        <p className="hint">
                                            <strong>Your claim ticket.</strong> In Fizz: <strong>Bridge → Import claim ticket</strong>. It
                                            only redeems this one deposit, for this recipient — but keep it until claimed.
                                        </p>
                                        <div className="ticket-box">{outcome.encoded}</div>
                                        <div className="row-actions">
                                            <CopyButton text={outcome.encoded} label="Copy claim ticket" />
                                            <a
                                                className="btn btn-ghost btn-small"
                                                href={`https://sepolia.etherscan.io/tx/${outcome.l1TxHash}`}
                                                target="_blank"
                                                rel="noopener noreferrer"
                                            >
                                                Deposit tx on Etherscan ↗
                                            </a>
                                            <button type="button" className="btn btn-ghost btn-small" onClick={resetFlow}>
                                                Bridge another
                                            </button>
                                        </div>
                                    </>
                                )}

                                <div className="note-box">
                                    <span className="live-dot" /> <strong>Canonical addresses</strong> — fetched live from the Aztec
                                    testnet node ({AZTEC_NODE_URL.replace("https://", "")}, v{node.info.nodeVersion}), never hardcoded:
                                    <table className="addr-table">
                                        <tbody>
                                            <tr>
                                                <td>FeeJuicePortal</td>
                                                <td><code>{node.info.feeJuicePortalAddress}</code></td>
                                            </tr>
                                            <tr>
                                                <td>Fee asset ({symbol})</td>
                                                <td><code>{node.info.feeJuiceAddress}</code></td>
                                            </tr>
                                            <tr>
                                                <td>Free minter</td>
                                                <td>
                                                    <code>{node.info.feeAssetHandlerAddress ?? "— none on this network"}</code>
                                                </td>
                                            </tr>
                                        </tbody>
                                    </table>
                                </div>
                            </>
                        )}
                    </>
                )}
            </section>

            {earlierRecords.length > 0 && (
                <section className="card">
                    <h2>Earlier bridges saved in this browser</h2>
                    <p className="hint">
                        Claim secrets are stored locally before anything is sent, so an interrupted bridge never
                        strands funds. Completed deposits can re-issue their ticket any time.
                    </p>
                    {earlierRecords.map((r) => (
                        <div className="record" key={r.id}>
                            <div className="record-head">
                                <span>
                                    {r.status === "deposited" ? "✓ Deposit confirmed" : "⏳ Started, deposit not confirmed"} →{" "}
                                    <code title={r.recipient}>{shortHex(r.recipient)}</code>
                                </span>
                                <span className="record-when">{new Date(r.createdAt).toLocaleString()}</span>
                            </div>
                            {r.status === "deposited" ? (
                                <div className="record-actions">
                                    <CopyButton text={ticketFromRecord(r)} label="Copy claim ticket" />
                                    <button type="button" className="btn btn-ghost btn-small" onClick={() => void sendRecordToFizz(r)}>
                                        Send to Fizz
                                    </button>
                                    <button type="button" className="btn btn-ghost btn-small" onClick={() => { removeRecord(r.id); setRecords(listRecords()); }}>
                                        Remove
                                    </button>
                                </div>
                            ) : (
                                <>
                                    <details>
                                        <summary>Claim secret (only useful if the deposit later confirmed)</summary>
                                        secret: <code>{r.claimSecret}</code>
                                        <br />
                                        {r.l1TxHash ? (
                                            <>
                                                deposit tx: <code>{r.l1TxHash}</code>
                                            </>
                                        ) : (
                                            "No deposit transaction was broadcast — safe to remove."
                                        )}
                                    </details>
                                    <div className="record-actions">
                                        <button type="button" className="btn btn-ghost btn-small" onClick={() => { removeRecord(r.id); setRecords(listRecords()); }}>
                                            Remove
                                        </button>
                                    </div>
                                </>
                            )}
                            {recordNotice?.id === r.id && <p className="small muted">{recordNotice.text}</p>}
                        </div>
                    ))}
                </section>
            )}

            <section className="explainers">
                <div className="explainer">
                    <div className="emoji">⛽</div>
                    <h3>What is fee juice?</h3>
                    <p>
                        Aztec's gas. It exists only on L2, can't be transferred between accounts, and can never
                        leave Aztec. Roughly <code>~2.3 fee juice</code> ≈ one transaction.
                    </p>
                </div>
                <div className="explainer">
                    <div className="emoji">🎫</div>
                    <h3>Lands in your Fizz wallet</h3>
                    <p>
                        The fee juice is deposited to the connected Fizz account and auto-pays its next
                        transaction. Until then, the wallet lists the pending claim under{" "}
                        <strong>“Need fee juice?”</strong>.
                    </p>
                </div>
                <div className="explainer">
                    <div className="emoji">➡️</div>
                    <h3>One-way by design</h3>
                    <p>
                        The protocol only mints fee juice from L1 deposits through this portal. There is no exit:
                        bridge what you'll use. Fee juice only — this portal moves nothing else.
                    </p>
                </div>
                <div className="explainer">
                    <div className="emoji">🫧</div>
                    <h3>Do you even need this?</h3>
                    <p>
                        Probably not yet! On the Aztec testnet, fees are usually <strong>sponsored</strong> — Fizz
                        works with an empty wallet. Bridging is for when you want to pay your own way.
                    </p>
                </div>
                <div className="explainer">
                    <div className="emoji">👁️</div>
                    <h3>Privacy note</h3>
                    <p>
                        Bridging is a <strong>public L1 action</strong>: it visibly links your Ethereum address to
                        the funded Aztec address. For privacy, fund the L1 side from an exchange or faucet — not
                        your main wallet.
                    </p>
                </div>
            </section>
        </Shell>
    );
}
