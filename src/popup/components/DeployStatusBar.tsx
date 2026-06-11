import { useDeployTask } from "../../lib/state/deployTask";

/**
 * Shell-level bottom bar shown on every screen EXCEPT the Deploy page while a
 * token deploy is running (or finished unacknowledged). The whole bar is the
 * link back to the live deploy — the user can roam the wallet freely without
 * losing the one thing they must not do: close the window mid-proof.
 */
export function DeployStatusBar({ onOpen }: { onOpen: () => void }) {
    const task = useDeployTask();
    if (!task) return null;

    if (task.phase === "running") {
        return (
            <button className="deploy-bar" onClick={onOpen}>
                <span className="spinner" />
                <span className="deploy-bar-text">
                    Deploying {task.symbol} — keep this window open
                </span>
                <span className="link">View →</span>
            </button>
        );
    }
    if (task.phase === "done") {
        return (
            <button className="deploy-bar success" onClick={onOpen}>
                <span aria-hidden>✓</span>
                <span className="deploy-bar-text">{task.symbol} deployed</span>
                <span className="link">View →</span>
            </button>
        );
    }
    return (
        <button className="deploy-bar failed" onClick={onOpen}>
            <span aria-hidden>!</span>
            <span className="deploy-bar-text">Deploying {task.symbol} failed</span>
            <span className="link">Details →</span>
        </button>
    );
}
