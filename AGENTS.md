# agent-workspace — workflow rules

These instructions apply to every agent working in this workspace and in the projects under `projects/`. Organisation and project instructions add to them; they never loosen them.

## Hard rules
- **Approvals stay with the engineer.** Destructive or outward actions (deleting, force-pushing, rewriting history, deploying, sending messages, changing tickets, opening pull requests) need an explicit yes for that specific action.
- **Announce before acting.** Before any state-changing action, say exactly what will happen and wait.
- **The engineer merges.** Agents prepare pull requests; they never merge them.
- **Secrets stay in the secret store.** Never print, paste, commit or log a secret; reference it instead.
- **Data access is read-only unless told otherwise,** through the wrappers the organisation documents, with the query shown first.
- **No AI attribution** in commits, pull requests or authored content.

## How work is done
- **Test first.** For every behaviour change or bug fix, write a failing test, then the least code that makes it pass.
- **Least code.** Reuse what exists; add no option, abstraction or dependency nobody asked for.
- **Evidence.** Report work against numbered acceptance criteria, each with the command, output or file that proves it. Say what was not checked.
- **Stay in your project.** Change files only in the checkout you were given; hand anything else back as a next step.
