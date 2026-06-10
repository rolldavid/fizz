import { useEffect, useState } from "react";
import { isToolbarPopup, openStandaloneWindow, type AppRoute } from "../../lib/runtime/standalone";

/**
 * Shown ONLY inside the toolbar popup, on pages that run multi-minute work
 * (deploy / send / mint / bridge). Chrome destroys that popup the moment it
 * loses focus — silently cancelling whatever was proving. Offers a one-click
 * jump to a standalone window that survives blur.
 */
export function StandaloneGuard({
    route,
    beforeOpen,
}: {
    route: AppRoute;
    /** Chance to stash form state (a draft) before the popup closes itself. */
    beforeOpen?: () => Promise<void> | void;
}) {
    const [fragile, setFragile] = useState(false);

    useEffect(() => {
        let alive = true;
        void isToolbarPopup().then((v) => alive && setFragile(v));
        return () => {
            alive = false;
        };
    }, []);

    if (!fragile) return null;

    return (
        <div
            className="card"
            style={{ borderColor: "var(--accent)", display: "flex", flexDirection: "column", gap: 8 }}
        >
            <div style={{ fontSize: 12, lineHeight: 1.5 }}>
                <strong>Heads-up:</strong> this little popup closes if you click anywhere
                else — and that cancels work in progress. Proving runs on your device and
                can take a few minutes, so use a window that stays open.
            </div>
            <button
                className="btn btn-primary btn-block"
                onClick={async () => {
                    await beforeOpen?.();
                    await openStandaloneWindow(route);
                }}
            >
                Open in a window →
            </button>
        </div>
    );
}
