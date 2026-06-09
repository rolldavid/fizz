/**
 * Fizz is a dark-mode wallet — one theme, tuned. The provider survives as a
 * stable seam (Receive uses `resolved` for QR colors) but always reports dark.
 */

import { createContext, useContext, type ReactNode } from "react";

type Ctx = {
    resolved: "dark";
};

const ThemeCtx = createContext<Ctx>({ resolved: "dark" });

export function ThemeProvider({ children }: { children: ReactNode }) {
    return <ThemeCtx.Provider value={{ resolved: "dark" }}>{children}</ThemeCtx.Provider>;
}

export function useTheme(): Ctx {
    return useContext(ThemeCtx);
}
