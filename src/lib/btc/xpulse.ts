import { createServerFn } from "@tanstack/react-start";
import type { XPulse } from "./intel";

export const getXPulse = createServerFn({ method: "GET" }).handler(async (): Promise<XPulse> => {
  return {
    ok: false,
    checkedAt: null,
    error: null,
    tone: "unavailable",
    score: 0,
    summary: "X signals are off.",
    events: [],
  };
});
