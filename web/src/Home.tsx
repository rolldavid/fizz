/** Home route — ported from the old static landing/index.html. The nav, footer,
 *  bubbles, and wallet chips live in <Layout>; this renders the page body and
 *  reuses platform detection (no inline script) for the desktop-only notice. */
import { useEffect } from "react";
import { Link } from "react-router-dom";
import { useConnection } from "./connection";
import { CHROME_STORE_URL } from "./config";

const AZTEC_DOCS = "https://docs.aztec.network";

export function Home() {
    const { platform } = useConnection();
    useEffect(() => {
        document.title = "Fizz — the lightweight private wallet for Aztec";
    }, []);

    // Desktop Chromium: CTA opens the Web Store listing. Otherwise steer to a
    // supported browser (matches the nav's Aztec button behaviour).
    const ctaLabel = platform.isMobile
        ? "Open on desktop to install"
        : !platform.isChromium
          ? "Use a Chromium browser"
          : "Add Fizz to Chrome";
    const ctaHref = platform.canUseExtension ? CHROME_STORE_URL : "#desktop-note";

    return (
        <>
            <header className="hero">
                <h1>
                    Private tokens, <em>with sparkle</em>.
                </h1>
                <p className="sub">
                    Fizz is a lightweight wallet for the Aztec network that lives in your browser. Send and
                    receive tokens privately, flip balances between private and public, and mint your own, with
                    zero-knowledge proofs generated right on your device.
                </p>
                <p className="lightweight">🫧 Built for quick, low-value transactions: pocket change, not vaults</p>
                <div className="cta-row">
                    <a
                        className="btn btn-primary"
                        href={ctaHref}
                        {...(platform.canUseExtension
                            ? { target: "_blank", rel: "noopener noreferrer" }
                            : {})}
                    >
                        {ctaLabel}
                    </a>
                    <a className="btn btn-ghost" href={AZTEC_DOCS} target="_blank" rel="noopener noreferrer">
                        What's Aztec?
                    </a>
                </div>
            </header>

            {!platform.canUseExtension && (
                <div id="desktop-note" className="desktop-required" role="status">
                    <div className="dr-emoji" aria-hidden="true">
                        🖥️
                    </div>
                    <h3>Best on desktop</h3>
                    <p>
                        {platform.isMobile
                            ? "Fizz is a browser-extension wallet. It runs in a desktop Chromium browser (Chrome, Brave, Edge, or Arc). Mobile browsers can't add extensions, so open this page on your computer to install Fizz."
                            : "Fizz currently supports Chromium browsers: Chrome, Brave, Edge, or Arc. A Firefox build is on the way."}
                    </p>
                </div>
            )}

            <section className="benefits">
                <div className="benefit">
                    <div className="emoji">🔒</div>
                    <h3>Private by default</h3>
                    <p>
                        Amounts, senders, and recipients stay hidden on-chain. Proofs are generated in your
                        browser. Your keys and data never leave the device.
                    </p>
                </div>
                <div className="benefit">
                    <div className="emoji">⚡</div>
                    <h3>Start in seconds</h3>
                    <p>
                        Network fees are sponsored on the Aztec testnet. Make your first private transaction with
                        an empty wallet. No bridging, no faucet queue.
                    </p>
                </div>
                <div className="benefit">
                    <div className="emoji">🫧</div>
                    <h3>Two balances, one tap</h3>
                    <p>
                        Every token has a private side and a public side. Convert between them whenever you like.
                        Shield when it matters, go public when it doesn't.
                    </p>
                </div>
                <div className="benefit">
                    <div className="emoji">🚀</div>
                    <h3>Make your own token</h3>
                    <p>
                        Deploy a standard Aztec token and mint supply, privately or publicly, straight from the
                        popup. Great for experiments, communities, and games.
                    </p>
                </div>
                <div className="benefit">
                    <div className="emoji">👥</div>
                    <h3>Multiple accounts</h3>
                    <p>
                        Spin up separate accounts from one recovery phrase to keep activities unlinkable on Aztec:
                        one for funding, one for spending. (Fund each from a different L1 source to keep them
                        unlinked on L1 too.)
                    </p>
                </div>
                <div className="benefit">
                    <div className="emoji">🪶</div>
                    <h3>Genuinely lightweight</h3>
                    <p>
                        No servers, no accounts, no tracking. A small extension that talks directly to the Aztec
                        node you choose, even your own.
                    </p>
                </div>
            </section>

            <section className="tools" aria-label="Companion tools">
                <Link className="tool" to="/bridge">
                    <div className="emoji">⛽</div>
                    <div>
                        <h3>
                            Get gas <span className="arrow">→</span>
                        </h3>
                        <p>
                            Bring your own gas: bridge AZTEC from your own Ethereum wallet on mainnet into fee
                            juice on your connected account.
                        </p>
                    </div>
                </Link>
            </section>

        </>
    );
}
