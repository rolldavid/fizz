import { useEffect, useState } from "react";
import { mainnet } from "wagmi/chains";
import {
    getAccount,
    readContract,
    simulateContract,
    switchChain,
    waitForTransactionReceipt,
    writeContract,
} from "wagmi/actions";
import { formatUnits, parseUnits, type Hex } from "viem";
import { ErrorBox, DesktopRequiredNotice } from "../components";
import { useConnection } from "../connection";
import { useEth } from "../eth/EthProvider";
import { EthConnect } from "../eth/EthConnect";
import { detectPlatform } from "../platform";
import { AZTEC_TOKEN_URL } from "../config";
import { fetchNodeInfo, type AztecNodeInfo } from "../nodeInfo";
import { getBridgeParams, notifyBridgeDeposited, prepareBridge } from "../extension";
import { feeAssetAbi, feeJuicePortalAbi } from "./abi";

/** Bridging serves a Fizz (desktop-Chromium) address; disable connecting on mobile. */
const PLATFORM = detectPlatform();

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

// idle -> opening Fizz -> waiting for in-wallet approval -> L1 deposit -> done.
type Phase = "idle" | "preparing" | "awaiting" | "depositing" | "done";

function errMessage(err: unknown): string {
    return err instanceof Error ? err.message : String(err);
}

/** Poll the wallet for the {recipient, secretHash} it produces once the user approves. */
async function waitForParams(timeoutMs = 180_000): Promise<{ recipient: string; secretHash: string }> {
    const started = Date.now();
    for (;;) {
        const params = await getBridgeParams();
        if (params) return params;
        if (Date.now() - started > timeoutMs) {
            throw new Error("Timed out waiting for approval. Approve the request in the Fizz window, then try again.");
        }
        await new Promise((r) => setTimeout(r, 2000));
    }
}

export function BridgePage() {
    // Ethereum (MetaMask/Rabby) connection — site-wide, lazy wagmi config. The
    // address only exists here after the user connects via the nav (no autoconnect).
    const { config, address: account, status: ethStatus } = useEth();
    const isConnected = ethStatus === "connected";
    // Aztec (Fizz) connection — required to bridge; the wallet provides the recipient.
    const { status: aztecStatus } = useConnection();

    useEffect(() => {
        document.title = "Bridge fee juice to Aztec — Fizz";
    }, []);

    const [node, setNode] = useState<NodeState>({ status: "loading" });
    const [asset, setAsset] = useState<AssetState>({ status: "loading" });
    const [balance, setBalance] = useState<BalanceState>({ status: "idle" });

    const [amountInput, setAmountInput] = useState("");
    const [phase, setPhase] = useState<Phase>("idle");
    const [error, setError] = useState<string | null>(null);
    const [depositTx, setDepositTx] = useState<string | null>(null);

    // ── data loading ─────────────────────────────────────────────────────────
    const loadNode = () => {
        setNode({ status: "loading" });
        fetchNodeInfo()
            .then((info) => setNode({ status: "ready", info }))
            .catch((err) => setNode({ status: "error", message: errMessage(err) }));
    };
    useEffect(loadNode, []);

    useEffect(() => {
        if (node.status !== "ready" || !config) return;
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
        if (node.status !== "ready" || !account || !config) {
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
    }, [config, node, account, depositTx]);

    const decimals = asset.status === "ready" ? asset.decimals : 18;
    const symbol = asset.status === "ready" ? asset.symbol : "AZTEC";
    const fmt = (v: bigint) => formatUnits(v, decimals);

    const hasBalance = balance.status === "ready" && balance.value > 0n;
    const amountValid = /^\d+(\.\d+)?$/.test(amountInput.trim()) && hasBalance;
    const running = phase !== "idle" && phase !== "done";
    const canStart =
        !running &&
        phase !== "done" &&
        isConnected &&
        aztecStatus === "connected" &&
        node.status === "ready" &&
        asset.status === "ready" &&
        amountValid;

    // ── the flow ─────────────────────────────────────────────────────────────
    async function run() {
        if (node.status !== "ready" || asset.status !== "ready") return;
        const info = node.info;
        setError(null);
        if (!config) return setError("Ethereum wallet isn't ready yet — give it a moment and try again.");
        if (aztecStatus !== "connected") return setError("Connect your Aztec wallet with Connect Wallet (top right).");
        if (!isConnected) return setError("Connect your Ethereum wallet with Connect Ethereum (top right).");

        let amountWei: bigint;
        try {
            amountWei = parseUnits(amountInput.trim(), asset.decimals);
        } catch {
            return setError("Enter a valid amount.");
        }
        if (amountWei <= 0n) return setError("Amount must be greater than zero.");
        if (balance.status === "ready" && amountWei > balance.value) {
            return setError(`Amount exceeds your balance of ${fmt(balance.value)} ${symbol}.`);
        }
        if (info.l1ChainId !== mainnet.id) {
            return setError(`The Aztec node reports L1 chain ${info.l1ChainId}, but this page only supports Ethereum mainnet.`);
        }

        try {
            // 1. Ask Fizz to prepare. It opens its own window where you approve;
            //    the wallet generates the claim secret + uses your connected
            //    account as the recipient. The secret never leaves the wallet.
            setPhase("preparing");
            await prepareBridge(amountWei.toString());

            // 2. Wait for the wallet to hand back the recipient + secret hash.
            setPhase("awaiting");
            const params = await waitForParams();

            // 3. The L1 deposit, from your Ethereum wallet.
            setPhase("depositing");
            const acct = getAccount(config);
            if (!acct.address) throw new Error("Connect an Ethereum wallet first.");
            if (acct.chainId !== mainnet.id) await switchChain(config, { chainId: mainnet.id });

            const approveHash = await writeContract(config, {
                abi: feeAssetAbi,
                address: info.feeJuiceAddress,
                functionName: "approve",
                args: [info.feeJuicePortalAddress, amountWei],
                chainId: mainnet.id,
            });
            const approveReceipt = await waitForTransactionReceipt(config, { hash: approveHash, chainId: mainnet.id });
            if (approveReceipt.status !== "success") throw new Error(`Approve transaction reverted (${approveHash}).`);

            const sim = await simulateContract(config, {
                abi: feeJuicePortalAbi,
                address: info.feeJuicePortalAddress,
                functionName: "depositToAztecPublic",
                args: [params.recipient as Hex, amountWei, params.secretHash as Hex],
                account: acct.address,
                chainId: mainnet.id,
            });
            const depositHash = await writeContract(config, sim.request);
            const receipt = await waitForTransactionReceipt(config, { hash: depositHash, chainId: mainnet.id });
            if (receipt.status !== "success") {
                throw new Error(`Deposit transaction reverted (${depositHash}). Nothing was bridged; retry is safe.`);
            }

            // 4. Tell Fizz the deposit landed. It verifies the receipt on-chain
            //    and completes the claim, which pays your next transaction.
            await notifyBridgeDeposited(params.secretHash, depositHash);
            setDepositTx(depositHash);
            setPhase("done");
        } catch (err) {
            setError(errMessage(err));
            setPhase("idle");
        }
    }

    function reset() {
        setPhase("idle");
        setError(null);
        setDepositTx(null);
        setAmountInput("");
    }

    const phaseLabel: Record<Phase, string> = {
        idle: "Bridge to my Aztec wallet",
        preparing: "Opening Fizz…",
        awaiting: "Approve in the Fizz window…",
        depositing: "Depositing on Ethereum…",
        done: "Done",
    };

    // ── render ─────────────────────────────────────────────────────────────
    return (
        <>
            <section className="page-hero">
                <span className="pill">Mainnet · Ethereum → Aztec</span>
                <h1>
                    Get <em>gas</em> on Aztec
                </h1>
                <p className="sub">
                    Bridge the AZTEC token from Ethereum mainnet to the Aztec Network to use as gas. Gas on Aztec is known as fee juice, 
                    and can be used to pay for txns, token deployments, and other contract interactions. 
                    
                    Sending AZTEC to your wallet to use for gas is a 1-way transaction, and your fee juice is not transferable out of your Fizz wallet.
                </p>
            </section>

            <section className="card">
                <div className="card-head">
                    <h2>Bridge</h2>
                </div>

                {PLATFORM.isMobile && <DesktopRequiredNotice reason="mobile" />}

                {!PLATFORM.isMobile && (
                    <>
                        {node.status === "loading" && <p className="hint">Reaching the Aztec mainnet node…</p>}
                        {node.status === "error" && (
                            <>
                                <ErrorBox title="Could not reach the Aztec mainnet node">{node.message}</ErrorBox>
                                <button type="button" className="btn btn-ghost btn-small" onClick={loadNode}>
                                    Retry
                                </button>
                            </>
                        )}
                        {asset.status === "error" && <ErrorBox title="Could not read the AZTEC fee asset">{asset.message}</ErrorBox>}

                        {node.status === "ready" && asset.status === "ready" && phase !== "done" && (
                            <>
                                <div className="bridge-cols">
                                    {/* LEFT — your Aztec (Fizz) wallet: the fee juice lands here. */}
                                    <div className="bridge-col">
                                        <div className="bridge-col-head">
                                            <span className="bridge-num">1</span> Your Aztec wallet
                                        </div>
                                        {aztecStatus === "connected" ? (
                                            <p className="hint" style={{ color: "var(--ok)", margin: 0 }}>
                                                ✓ Aztec wallet connected (Fizz). The fee juice goes straight to it.
                                            </p>
                                        ) : (
                                            <p className="hint" style={{ margin: 0 }}>
                                                Connect your <strong>Aztec wallet</strong> with{" "}
                                                <strong>Connect Wallet</strong> (top right). The gas is sent
                                                to your connected account.
                                            </p>
                                        )}
                                    </div>

                                    {/* RIGHT — your Ethereum wallet: holds the AZTEC and pays L1 gas. */}
                                    <div className="bridge-col">
                                        <div className="bridge-col-head">
                                            <span className="bridge-num">2</span> Your Ethereum wallet
                                        </div>
                                        <EthConnect />
                                        <p
                                            className="hint"
                                            style={{ margin: 0, color: isConnected ? "var(--ok)" : undefined }}
                                        >
                                            {isConnected
                                                ? "✓ Connected — it holds the AZTEC and pays the L1 gas."
                                                : "Connect MetaMask or Rabby — it holds the AZTEC and pays the L1 gas."}
                                        </p>
                                        {isConnected && balance.status === "ready" && balance.value === 0n && (
                                            <div className="note-box" style={{ marginTop: 12 }}>
                                                <strong>You have no {symbol} on Ethereum mainnet.</strong>. Get {symbol}{" "}
                                                at{" "}
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
                                                disabled={running || !hasBalance}
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
                                                        disabled={running}
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

                                <div className="row-actions">
                                    <button type="button" className="btn btn-primary" disabled={!canStart} onClick={() => void run()}>
                                        {running ? <span className="spin">{phaseLabel[phase]}</span> : phaseLabel.idle}
                                    </button>
                                </div>

                                {phase === "awaiting" && (
                                    <p className="hint" style={{ marginTop: 10 }}>
                                        A Fizz window opened. Approve funding your wallet there, then come back; the
                                        deposit continues here automatically.
                                    </p>
                                )}

                                {error !== null && <ErrorBox title="Bridge step failed">{error}</ErrorBox>}
                            </>
                        )}

                        {phase === "done" && (
                            <>
                                <div className="ok-box">
                                    <strong>Fee juice is on the way 🫧</strong>
                                    <br />
                                    Your deposit is on L1. Fizz is completing the claim for your connected account;
                                    it pays your next transaction automatically once it lands on L2 (a few minutes).
                                    There's nothing to copy.
                                </div>
                                <div className="row-actions">
                                    {depositTx && (
                                        <a
                                            className="btn btn-ghost btn-small"
                                            href={`https://etherscan.io/tx/${depositTx}`}
                                            target="_blank"
                                            rel="noopener noreferrer"
                                        >
                                            Deposit tx on Etherscan ↗
                                        </a>
                                    )}
                                    <button type="button" className="btn btn-ghost btn-small" onClick={reset}>
                                        Bridge more
                                    </button>
                                </div>
                            </>
                        )}
                    </>
                )}
            </section>

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
                        On mainnet the L1 fee asset is the <strong>AZTEC</strong> token. You bridge AZTEC through
                        the canonical FeeJuicePortal; it's locked on L1 and the same amount of fee juice is minted
                        to your Aztec address. Get AZTEC at{" "}
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
                    <div className="emoji">✨</div>
                    <h3>No claim ticket</h3>
                    <p>
                        Fizz generates the claim secret and keeps it. After your deposit, the wallet completes the
                        claim for your connected account on its own. Nothing to copy or paste.
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
                        the funded Aztec address. For privacy, fund the L1 side from an exchange or a fresh address,
                        not a wallet that's publicly you. This page contacts the Aztec node and a public mainnet
                        RPC (which see your IP). It connects MetaMask or Rabby directly — there's no WalletConnect
                        relay.
                    </p>
                </div>
            </section>
        </>
    );
}
