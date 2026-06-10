import { useEffect, useRef, useState } from "react";
import { ConnectButton } from "@rainbow-me/rainbowkit";
import { useAccount, useConfig } from "wagmi";
import { mainnet } from "wagmi/chains";
import {
    getAccount,
    readContract,
    simulateContract,
    switchChain,
    waitForTransactionReceipt,
    writeContract,
} from "wagmi/actions";
import { formatUnits, parseEventLogs, parseUnits } from "viem";
import { Shell, ErrorBox, CopyButton, DesktopRequiredNotice, shortHex } from "../components";
import { useConnection } from "../connection";
import { detectPlatform } from "../platform";
import { AZTEC_NETWORK_ID, AZTEC_TOKEN_URL } from "../config";
import { fetchNodeInfo, type AztecNodeInfo, type Hex } from "../nodeInfo";
import { encodeClaimTicket, type ClaimTicket } from "../claimTicket";
import { feeAssetAbi, feeJuicePortalAbi } from "./abi";
import { generateClaimSecretPair, type ClaimSecretPair } from "./secret";
import { clearRecords, createRecord, listRecords, removeRecord, updateRecord, type PendingRecord } from "./pending";

/** Bridging serves a Fizz (desktop-Chromium) address; disable connecting on mobile. */
const PLATFORM = detectPlatform();

/** An Aztec address: 0x + 32 bytes. The recipient the user types — the only fund destination. */
const AZTEC_ADDRESS_RE = /^0x[0-9a-fA-F]{64}$/;
/**
 * Aztec addresses live in the BN254 scalar field, so a valid address is < p.
 * ~80% of random 64-hex values exceed p; a wrong/corrupted paste that's still
 * 64 hex chars would deposit to an address that can never redeem on L2 —
 * stranding the funds. Range-check before locking the recipient.
 */
const BN254_MODULUS = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;
function isValidAztecAddress(s: string): boolean {
    if (!AZTEC_ADDRESS_RE.test(s)) return false;
    const n = BigInt(s);
    return n > 0n && n < BN254_MODULUS;
}
const lower = (h: string) => h.toLowerCase();

type NodeState =
    | { status: "loading" }
    | { status: "error"; message: string }
    | { status: "ready"; info: AztecNodeInfo };

type AssetState =
    | { status: "loading" }
    | { status: "error"; message: string }
    | { status: "ready"; symbol: string; decimals: number };

type BalanceState =
    | { status: "idle" }
    | { status: "loading" }
    | { status: "error"; message: string }
    | { status: "ready"; value: bigint };

type StepId = "secret" | "approve" | "deposit";
type StepStatus = "todo" | "active" | "done" | "failed";

type Outcome = {
    encoded: string;
    recordId: string;
    recipient: string;
    amount: bigint;
    l1TxHash: Hex;
};

/** Mutable flow progress so a Retry resumes instead of redoing (and never regenerates the secret). */
type Progress = {
    secretPair?: ClaimSecretPair;
    recordId?: string;
    /** Recipient locked at first run — editing the field mid-flow must not divert a retry's claim. */
    recipient?: string;
    amount?: bigint;
    approveDone: boolean;
    depositHash?: Hex;
};

const freshProgress = (): Progress => ({ approveDone: false });
const ALL_TODO: Record<StepId, StepStatus> = { secret: "todo", approve: "todo", deposit: "todo" };

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
    // Aztec (Fizz) connection — shown on the left; the Eth wallet is on the right.
    const { status: aztecStatus } = useConnection();

    const [node, setNode] = useState<NodeState>({ status: "loading" });
    const [asset, setAsset] = useState<AssetState>({ status: "loading" });
    const [balance, setBalance] = useState<BalanceState>({ status: "idle" });

    // The recipient is typed in — any Aztec L2 address.
    const [recipientInput, setRecipientInput] = useState("");
    const [amountInput, setAmountInput] = useState("");

    const [running, setRunning] = useState(false);
    const [stepStatus, setStepStatus] = useState<Record<StepId, StepStatus>>(ALL_TODO);
    const [flowError, setFlowError] = useState<string | null>(null);
    const [outcome, setOutcome] = useState<Outcome | null>(null);
    const progress = useRef<Progress>(freshProgress());

    const [records, setRecords] = useState<PendingRecord[]>([]);

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
        const { feeJuiceAddress } = node.info;
        let cancelled = false;
        setAsset({ status: "loading" });
        (async () => {
            const [symbol, decimals] = await Promise.all([
                readContract(config, { abi: feeAssetAbi, address: feeJuiceAddress, functionName: "symbol", chainId: mainnet.id }),
                readContract(config, { abi: feeAssetAbi, address: feeJuiceAddress, functionName: "decimals", chainId: mainnet.id }),
            ]);
            if (!cancelled) setAsset({ status: "ready", symbol, decimals });
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
            chainId: mainnet.id,
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

    // ── derived form validity ───────────────────────────────────────────────
    const decimals = asset.status === "ready" ? asset.decimals : 18;
    const symbol = asset.status === "ready" ? asset.symbol : "AZTEC";
    const fmt = (v: bigint) => formatUnits(v, decimals);

    const recipientTrimmed = recipientInput.trim();
    const recipientValid = isValidAztecAddress(recipientTrimmed);
    const hasBalance = balance.status === "ready" && balance.value > 0n;
    const amountValid = /^\d+(\.\d+)?$/.test(amountInput.trim()) && hasBalance;

    const flowLocked = progress.current.secretPair !== undefined && outcome === null;
    const canStart =
        !running &&
        outcome === null &&
        isConnected &&
        node.status === "ready" &&
        asset.status === "ready" &&
        recipientValid &&
        amountValid;

    const steps: { id: StepId; label: string; note?: string }[] = [
        {
            id: "secret",
            label: "Generate & save the claim secret",
            note: "stored in this browser before any transaction — fund safety",
        },
        { id: "approve", label: `Approve the portal to pull your ${symbol}` },
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
            if (!recipientValid) {
                throw new Error(
                    "Enter a valid Aztec address (0x + 64 hex, within the field) — a malformed " +
                        "recipient would strand the funds on L1.",
                );
            }
            if (info.l1ChainId !== mainnet.id) {
                throw new Error(
                    `The Aztec node reports L1 chain ${info.l1ChainId}, but this page only supports Ethereum mainnet (${mainnet.id}).`,
                );
            }
            if (acct.chainId !== mainnet.id) {
                await switchChain(config, { chainId: mainnet.id });
            }

            // Lock the recipient on first run so editing the field can't point a
            // retry away from the already-saved claim record.
            if (progress.current.recipient === undefined) {
                progress.current.recipient = recipientTrimmed;
            }
            const recipient = progress.current.recipient;

            // Lock the amount on first run so retries can't drift.
            if (progress.current.amount === undefined) {
                if (balance.status !== "ready") throw new Error(`Your ${meta.symbol} balance has not loaded yet.`);
                const parsed = parseUnits(amountInput.trim(), meta.decimals);
                if (parsed <= 0n) throw new Error("Amount must be greater than zero.");
                if (parsed > balance.value) {
                    throw new Error(`Amount exceeds your balance of ${fmt(balance.value)} ${meta.symbol}.`);
                }
                progress.current.amount = parsed;
            }
            const amount = progress.current.amount;

            // 1 — claim secret, persisted BEFORE any L1 transaction.
            active = "secret";
            setStep("secret", "active");
            if (!progress.current.secretPair) {
                const pair = await generateClaimSecretPair();
                const record = createRecord({
                    networkId: AZTEC_NETWORK_ID,
                    l1ChainId: mainnet.id,
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

            // 2 — approve the portal to pull the user's AZTEC.
            if (!progress.current.approveDone) {
                active = "approve";
                setStep("approve", "active");
                const approveHash = await writeContract(config, {
                    abi: feeAssetAbi,
                    address: info.feeJuiceAddress,
                    functionName: "approve",
                    args: [info.feeJuicePortalAddress, amount],
                    chainId: mainnet.id,
                });
                const approveReceipt = await waitForTransactionReceipt(config, { hash: approveHash, chainId: mainnet.id });
                if (approveReceipt.status !== "success") {
                    throw new Error(`Approve transaction reverted on L1 (${approveHash}).`);
                }
                progress.current.approveDone = true;
            }
            setStep("approve", "done");

            // 3 — the deposit itself (simulated first to surface reverts early).
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
                    chainId: mainnet.id,
                });
                depositHash = await writeContract(config, sim.request);
                progress.current.depositHash = depositHash;
                updateRecord(recordId, { l1TxHash: depositHash });
                setRecords(listRecords());
            }
            const receipt = await waitForTransactionReceipt(config, { hash: depositHash, chainId: mainnet.id });
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
                    lower(log.args.secretHash) === lower(secretHash) &&
                    // Defense-in-depth: also bind the recipient + amount, not just
                    // the (already-unique) secret hash.
                    lower(log.args.to) === lower(recipient) &&
                    log.args.amount === amount,
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

            setOutcome({ encoded, recordId, recipient, amount, l1TxHash: depositHash });
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

    const earlierRecords = records.filter((r) => r.id !== outcome?.recordId && r.id !== progress.current.recordId);

    // ── render ──────────────────────────────────────────────────────────────
    return (
        <Shell page="bridge">
            <section className="page-hero">
                <span className="pill">Mainnet · Ethereum → Aztec</span>
                <h1>
                    Get <em>fee juice</em> (gas) on Aztec
                </h1>
                <p className="sub">
                    Bridge the AZTEC token from Ethereum mainnet into fee juice on any Aztec address — from your
                    own Ethereum wallet. Fee juice only, one-way only: both are Aztec protocol rules, not ours.
                    This moves real AZTEC; double-check the amount and recipient.
                </p>
            </section>

            <section className="card">
                <div className="card-head">
                    <h2>Bridge</h2>
                </div>

                {/* Mobile can't run Fizz (a desktop extension), and bridging only
                    serves a Fizz address — so disable connecting a wallet here. */}
                {PLATFORM.isMobile && <DesktopRequiredNotice reason="mobile" />}

                {!PLATFORM.isMobile && (
                  <>
                {node.status === "loading" && <p className="hint">Fetching canonical addresses from the Aztec mainnet node…</p>}
                {node.status === "error" && (
                    <>
                        <ErrorBox title="Could not reach the Aztec mainnet node">{node.message}</ErrorBox>
                        <button type="button" className="btn btn-ghost btn-small" onClick={loadNode}>
                            Retry
                        </button>
                    </>
                )}
                {asset.status === "error" && <ErrorBox title="Could not read the AZTEC fee asset">{asset.message}</ErrorBox>}

                {node.status === "ready" && asset.status === "ready" && (
                    <>
                        <div className="bridge-cols">
                            {/* LEFT — your Aztec (Fizz) wallet: where the fee juice lands. */}
                            <div className="bridge-col">
                                <div className="bridge-col-head">
                                    <span className="bridge-num">1</span> Your Aztec wallet
                                </div>
                                {aztecStatus === "connected" ? (
                                    <p className="hint" style={{ color: "var(--ok)", margin: 0 }}>
                                        ✓ Aztec wallet connected (Fizz)
                                    </p>
                                ) : (
                                    <p className="hint" style={{ margin: 0 }}>
                                        Connect your <strong>Aztec wallet</strong> with{" "}
                                        <strong>Connect Wallet</strong> (top right). The fee juice lands on the
                                        Aztec address below.
                                    </p>
                                )}
                                <div className="field">
                                    <label htmlFor="recipient">Aztec address to receive the fee juice</label>
                                    <input
                                        id="recipient"
                                        type="text"
                                        placeholder="0x… (your Fizz Receive address)"
                                        value={recipientInput}
                                        onChange={(e) => setRecipientInput(e.target.value)}
                                        disabled={flowLocked || running}
                                        spellCheck={false}
                                        autoComplete="off"
                                        autoCorrect="off"
                                        autoCapitalize="off"
                                    />
                                    {recipientTrimmed !== "" && !recipientValid && (
                                        <p className="sub-label" style={{ color: "var(--warn)" }}>
                                            That isn't a valid Aztec address. It should be 0x followed by 64 hex
                                            characters.
                                        </p>
                                    )}
                                    {recipientValid && (
                                        <p className="sub-label">
                                            Fee juice will be claimable by this address only. It's baked into the
                                            L1→L2 message and can't be redirected.
                                        </p>
                                    )}
                                </div>
                            </div>

                            {/* RIGHT — your Ethereum wallet: holds the AZTEC and pays L1 gas. */}
                            <div className="bridge-col">
                                <div className="bridge-col-head">
                                    <span className="bridge-num">2</span> Your Ethereum wallet
                                </div>
                                <ConnectButton showBalance={false} />
                                {isConnected && balance.status === "ready" && balance.value === 0n && (
                                    <div className="note-box" style={{ marginTop: 12 }}>
                                        <strong>You have no {symbol} on Ethereum mainnet.</strong> Fee juice is
                                        bridged from the AZTEC token (no faucet on mainnet). Get {symbol} at{" "}
                                        <a href={AZTEC_TOKEN_URL} target="_blank" rel="noopener noreferrer">
                                            {AZTEC_TOKEN_URL.replace("https://", "")}
                                        </a>
                                        , then come back.
                                    </div>
                                )}
                                <div className="field">
                                    <label htmlFor="amount">
                                        Amount of {symbol} to bridge
                                        {balance.status === "ready" && ` (balance: ${fmt(balance.value)})`}
                                    </label>
                                    <input
                                        id="amount"
                                        type="text"
                                        inputMode="decimal"
                                        placeholder={balance.status === "ready" ? fmt(balance.value) : "0"}
                                        value={amountInput}
                                        onChange={(e) => setAmountInput(e.target.value)}
                                        disabled={flowLocked || running || !hasBalance}
                                        spellCheck={false}
                                        autoComplete="off"
                                    />
                                    {balance.status === "loading" && <p className="sub-label">Loading your balance…</p>}
                                    {balance.status === "error" && (
                                        <p className="sub-label" style={{ color: "var(--warn)" }}>
                                            Balance lookup failed: {balance.message}
                                        </p>
                                    )}
                                    {hasBalance && (
                                        <p className="sub-label">
                                            <button
                                                type="button"
                                                className="btn btn-ghost btn-small"
                                                disabled={flowLocked || running}
                                                onClick={() => setAmountInput(fmt(balance.value))}
                                            >
                                                Use full balance
                                            </button>{" "}
                                            Roughly ~2.3 fee juice ≈ one Aztec transaction.
                                        </p>
                                    )}
                                </div>
                            </div>
                        </div>

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
                                    The deposit is on L1. Import the claim ticket below in your Aztec wallet at this
                                    address — it auto-pays the next transaction once the message lands on L2 (a few
                                    minutes).
                                </div>
                                <p className="hint">
                                    <strong>Your claim ticket.</strong> In Fizz: <strong>Need fee juice? → Import claim
                                    ticket</strong>. It only redeems this one deposit, for this recipient — but keep it
                                    until claimed.
                                </p>
                                <div className="ticket-box">{outcome.encoded}</div>
                                <div className="row-actions">
                                    <CopyButton text={outcome.encoded} label="Copy claim ticket" />
                                    <a
                                        className="btn btn-ghost btn-small"
                                        href={`https://etherscan.io/tx/${outcome.l1TxHash}`}
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
                        strands funds. Completed deposits can re-issue their ticket any time. On a shared computer,
                        clear these when you're done.
                        <br />
                        <button
                            type="button"
                            className="btn btn-ghost btn-small"
                            style={{ marginTop: 6 }}
                            onClick={() => {
                                clearRecords();
                                setRecords(listRecords());
                            }}
                        >
                            Clear saved bridges
                        </button>
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
                    <div className="emoji">🪙</div>
                    <h3>Bridged from AZTEC</h3>
                    <p>
                        On mainnet the L1 fee asset is the <strong>AZTEC</strong> token. You bridge AZTEC through the
                        canonical FeeJuicePortal; it's locked on L1 and the same amount of fee juice is minted to
                        your Aztec address. Get AZTEC at{" "}
                        <a href={AZTEC_TOKEN_URL} target="_blank" rel="noopener noreferrer">
                            {AZTEC_TOKEN_URL.replace("https://", "")}
                        </a>
                        .
                        {node.status === "ready" && (
                            <>
                                {" "}
                                <a
                                    href={`https://etherscan.io/address/${node.info.feeJuiceAddress}`}
                                    target="_blank"
                                    rel="noopener noreferrer"
                                >
                                    AZTEC token on Etherscan ↗
                                </a>
                            </>
                        )}
                    </p>
                </div>
                <div className="explainer">
                    <div className="emoji">🎫</div>
                    <h3>You get a claim ticket</h3>
                    <p>
                        The deposit produces a ticket you import in your Aztec wallet (in Fizz:{" "}
                        <strong>Need fee juice? → Import claim ticket</strong>). It auto-pays that address's next
                        transaction.
                    </p>
                </div>
                <div className="explainer">
                    <div className="emoji">➡️</div>
                    <h3>One-way by design</h3>
                    <p>
                        The protocol only mints fee juice from L1 deposits through this portal. There is no exit:
                        bridge what you'll use. Fee juice only; this portal moves nothing else.
                        {node.status === "ready" && (
                            <>
                                {" "}
                                <a
                                    href={`https://etherscan.io/address/${node.info.feeJuicePortalAddress}`}
                                    target="_blank"
                                    rel="noopener noreferrer"
                                >
                                    FeeJuicePortal on Etherscan ↗
                                </a>
                            </>
                        )}
                    </p>
                </div>
                <div className="explainer">
                    <div className="emoji">👁️</div>
                    <h3>Privacy note</h3>
                    <p>
                        Bridging is a <strong>public L1 action</strong>: it visibly links your Ethereum address to
                        the funded Aztec address. For privacy, fund the L1 side from an exchange or fresh address —
                        not a wallet that's publicly you. This page contacts the Aztec node and a public mainnet
                        RPC (which see your IP); the WalletConnect option also uses WalletConnect's relay — an
                        injected wallet (MetaMask, Rabby) avoids that.
                    </p>
                </div>
            </section>
        </Shell>
    );
}
