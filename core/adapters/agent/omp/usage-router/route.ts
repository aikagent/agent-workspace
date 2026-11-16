/** Subset of `omp usage --json` the router reads. */
export interface UsageLimit {
  id: string;
  amount: { usedFraction?: number };
  window?: { durationMs?: number; resetsAt?: number };
  /** shared: gates every model of the account; otherwise modelId or tier narrows the meter to matching models. */
  scope?: { tier?: string; modelId?: string; shared?: boolean };
}

/** One report per signed-in account; a provider can have several. */
export interface UsageReport {
  provider: string;
  limits: UsageLimit[];
}

/** Percent used at which a provider is skipped: short = windows under a day (e.g. 5h), week = the rest. */
export interface Limits {
  short: number;
  week: number;
}

const DAY = 86_400_000;

const appliesTo = (l: UsageLimit, id: string) =>
  l.scope?.shared === true || (l.scope?.modelId ? l.scope.modelId === id : !l.scope?.tier || id.includes(l.scope.tier));

/** Soonest short-window reset of an account under the limits for this model, or undefined when it is not usable. */
function accountReset(report: UsageReport, id: string, now: number, limits: Limits): number | undefined {
  const meters = report.limits.filter((l) => typeof l.amount.usedFraction === "number" && appliesTo(l, id));
  // Unknown usage is not usable: we cannot tell whether it is about to run out.
  if (meters.length === 0) return undefined;
  const isShort = (l: UsageLimit) => (l.window?.durationMs ?? Infinity) < DAY;
  // Reports are cached for a minute or two; a window that has already reset no longer counts.
  const live = meters.filter((l) => (l.window?.resetsAt ?? Infinity) > now);
  if (live.some((l) => (l.amount.usedFraction ?? 0) * 100 >= (isShort(l) ? limits.short : limits.week))) return undefined;
  return Math.min(Infinity, ...live.filter(isShort).map((l) => l.window?.resetsAt ?? Infinity));
}

/**
 * Orders a role's models for a subagent spawn. A model is eligible while one account of its provider reports usage
 * and is under the limit for every meter that applies to it. Eligible models whose short window resets soonest go
 * first (that quota expires unused otherwise); ties keep the configured order. Undefined when nothing is eligible.
 */
export function pickModels(models: string[], reports: UsageReport[], now: number, limits: Limits): string[] | undefined {
  const eligible: { model: string; resetsAt: number }[] = [];
  for (const model of models) {
    const slash = model.indexOf("/");
    const provider = model.slice(0, slash);
    const id = model.slice(slash + 1);
    const resets = reports
      .filter((r) => r.provider === provider)
      .map((r) => accountReset(r, id, now, limits))
      .filter((t): t is number => t !== undefined);
    if (resets.length) eligible.push({ model, resetsAt: Math.min(...resets) });
  }
  if (eligible.length === 0) return undefined;
  return eligible.sort((a, b) => a.resetsAt - b.resetsAt).map((e) => e.model);
}
