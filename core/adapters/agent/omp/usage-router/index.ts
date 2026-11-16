/**
 * usage-router for agent-workspace project agents (loaded with `omp -e`; generated launch commands add it when
 * routing is on). Picks each subagent's model from live subscription usage; rules in ./route.ts.
 * Config: the JSON file named by AGENT_WORKSPACE_ROUTING ({ short, week, roles: { <model role>: [models] } }).
 * Only spawns on a routed model role are touched; any failure (config, usage fetch, parse) leaves omp's routing in charge.
 */
import { readFileSync } from "node:fs";
import { pickModels, type Limits, type UsageReport } from "./route";

const CACHE_MS = 60_000;

interface Routing extends Limits {
  roles: Record<string, string[]>;
}

interface SpawnEvent {
  agent: string;
  modelRole?: string;
}

function loadRouting(): Routing | undefined {
  const file = process.env.AGENT_WORKSPACE_ROUTING;
  if (!file) return undefined;
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return undefined;
  }
}

export default function (pi) {
  const routing = loadRouting();
  if (!routing) return;
  // Cache the pending fetch, not its result: a task batch spawns many children at once, one hook call each.
  let cached: { at: number; reports: Promise<UsageReport[] | undefined> } | undefined;

  async function fetchReports(): Promise<UsageReport[] | undefined> {
    const r = await pi.exec("omp", ["usage", "--json"], { timeout: 20_000 }).catch(() => undefined);
    if (r?.code !== 0) return undefined;
    try {
      return JSON.parse(r.stdout).reports ?? [];
    } catch {
      return undefined;
    }
  }

  function usage(): Promise<UsageReport[] | undefined> {
    if (!cached || Date.now() - cached.at >= CACHE_MS) cached = { at: Date.now(), reports: fetchReports() };
    return cached.reports;
  }

  pi.on("before_subagent_spawn", async (event: SpawnEvent) => {
    // The bundled `task` agent runs on the task role when it names none.
    const models = routing.roles[event.modelRole ?? (event.agent === "task" ? "task" : "")];
    if (!models?.length) return;
    const reports = await usage();
    if (!reports) return;
    const picked = pickModels(models, reports, Date.now(), routing);
    if (!picked) return;
    return { model: picked, note: `agent-workspace usage-router: ${picked[0]}` };
  });
}
