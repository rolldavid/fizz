import { Header } from "../components/Header";
import { useWallet } from "../../lib/state/walletContext";

/**
 * Token creation lives on fizzwallet.com/launch (the wallet stays a wallet) —
 * the launcher hands the deploy to this wallet, which proves it locally. This
 * screen is the in-wallet pointer to it, plus a secondary path to mint more of
 * a token you already deployed.
 */
export function CreateTokens({ onBack, onMintMore }: { onBack: () => void; onMintMore: () => void }) {
    const { network } = useWallet();
    const isAlpha = network.id === "alpha";

    return (
        <>
            <Header />
            <div className="content">
                <button className="muted" style={{ alignSelf: "flex-start" }} onClick={onBack}>
                    ← Back
                </button>
                <div style={{ fontWeight: 600, fontSize: 16 }}>Create a token</div>

                <p className="hint">
                    Launch your own token on Aztec: public + private balances and shielding built
                    in. You design it on the web and confirm the deploy right here in Fizz;
                    {isAlpha
                        ? " proving runs on your device, and you'll need a little gas (fee juice) to deploy."
                        : " proving runs on your device."}
                </p>

                <div
                    className="card card-accent"
                    style={{ display: "flex", flexDirection: "column", gap: 8 }}
                >
                    <div style={{ fontWeight: 600 }}>Launch a token</div>
                    <div className="hint" style={{ margin: 0 }}>
                        Open the launcher, fill in the details, and it hands the deploy to this
                        wallet to review and confirm.
                    </div>
                    <a
                        className="btn btn-primary btn-block"
                        href="https://fizzwallet.com/launch"
                        target="_blank"
                        rel="noreferrer"
                    >
                        Open fizzwallet.com/launch ↗
                    </a>
                </div>

                <button className="btn btn-ghost btn-block" onClick={onMintMore}>
                    Already deployed a token? Mint more supply →
                </button>
            </div>
        </>
    );
}
