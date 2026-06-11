import { Header } from "../components/Header";
import { useWallet } from "../../lib/state/walletContext";

/**
 * Token creation hub: deploy a new token (fully in-wallet — form, proving, and
 * result all live on the Deploy screen) or mint more of one you already own.
 */
export function CreateTokens({
    onBack,
    onDeploy,
    onMintMore,
}: {
    onBack: () => void;
    onDeploy: () => void;
    onMintMore: () => void;
}) {
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
                    in. Everything happens right here in Fizz;
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
                        Name it, pick a supply, and deploy. You can keep using the wallet while it
                        proves — just keep the window open.
                    </div>
                    <button className="btn btn-primary btn-block" onClick={onDeploy}>
                        Deploy a token →
                    </button>
                </div>

                <button className="btn btn-ghost btn-block" onClick={onMintMore}>
                    Already deployed a token? Mint more supply →
                </button>
            </div>
        </>
    );
}
