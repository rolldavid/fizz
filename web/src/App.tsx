/** SPA router. One Layout (nav + footer) wraps every route; the heavy bridge
 *  page is lazy-loaded so the home's initial payload stays small. */
import { lazy, Suspense } from "react";
import { createBrowserRouter, RouterProvider } from "react-router-dom";
import { Layout } from "./components";
import { Home } from "./Home";

const BridgePage = lazy(() => import("./bridge/BridgePage").then((m) => ({ default: m.BridgePage })));

function RouteLoading() {
    return <p className="hint" style={{ textAlign: "center", padding: "48px 0" }}>Loading…</p>;
}

const router = createBrowserRouter([
    {
        element: <Layout />,
        children: [
            { index: true, element: <Home /> },
            {
                path: "bridge",
                element: (
                    <Suspense fallback={<RouteLoading />}>
                        <BridgePage />
                    </Suspense>
                ),
            },
            // Unknown client-side paths fall back to home.
            { path: "*", element: <Home /> },
        ],
    },
]);

export function App() {
    return <RouterProvider router={router} />;
}
