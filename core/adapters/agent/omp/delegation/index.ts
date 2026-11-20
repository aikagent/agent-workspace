/**
 * Main→project-agent delegation for agent-workspace (loaded with `omp -e` by generated launch commands when
 * `delegation: on`, and by the committed Main loader `<root>/.omp/extensions/delegation.ts`).
 * One extension, two roles: a project agent (OMP_DELEGATION_PROJECT=<org>/<project>/<role>, set by the Tern plugin)
 * or Main (workspace root only, and only when workspace.yml has `delegation: on`).
 */
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { delegationOn, isWorkspaceRoot, runtimeDir, workspaceRoot } from "./src/config";
import { Mailbox } from "./src/mailbox";
import { registerMainSide } from "./src/main-side";
import { registerProjectSide } from "./src/project-side";

export default function delegation(pi: ExtensionAPI): void {
  const mb = new Mailbox(runtimeDir());
  const agentKey = process.env.OMP_DELEGATION_PROJECT;
  if (agentKey) return registerProjectSide(pi, agentKey, mb);
  const root = workspaceRoot();
  if (delegationOn(root) && isWorkspaceRoot(root, process.cwd())) registerMainSide(pi, mb, root);
}
