---
description: Finish agent-workspace setup with the engineer (orgs, projects, roles, MCP, model routing, notes vault, verify)
---

# /workspace-setup

You are completing agent-workspace setup with the engineer, from the tool's root folder. The bootstrap already confirmed the AI provider and the agent work.

## Rules for this session
- Workspace changes (orgs, projects, agents, workspace.yml) go through `./setup` subcommands; do not write those files yourself, and never touch files under `projects/` except through `./setup`. The one exception is step 6: entries for the agent's own user MCP config, written only after the engineer's yes.
- Announce each command before you run it and wait for the engineer's yes.
- Never print, paste or store a secret. Tokens become environment or secret-store references.
- Ask one question at a time. Propose a default for each.

## Steps
1. **Where we are.** Run `./setup check` and `./setup verify`; summarise what is already set up.
2. **Organisation.** Ask whether the engineer's team has an org repo (a private repo made from `core/templates/org`). If yes, get its git URL and run `./setup org add <url>`. If not, offer to continue without one (they can add projects by creating an org repo later).
3. **Projects.** List the projects the org offers (`orgs/<org>/projects/*/project.yml`, show `name`). Ask which ones they work on. For each: `./setup project add <org>/<project>`. A repo without a url is created as an empty folder: tell the engineer to put that folder's files there.
4. **Roles.** For each project, list roles available at the three levels: core (`core/workflow/roles`), org (`orgs/<org>/roles`), project (`orgs/<org>/projects/<project>/roles`). Explain each in one line. For each chosen role: `./setup role add <org>/<project> <role>`, then show the generated `agents/<org>/<project>/<role>/agent.yml` and `role.md`. If a role is refused (it loosens a parent, skips a level, or uses an MCP server the org blocks or does not allow), explain why and continue.
5. **Project context.** For each project, read the repo (README, build and test files) and draft additions to the org's `projects/<project>/context.md` and `glossary.md`. Show the draft. Those files belong to the org repo: if the engineer agrees, tell them which file to update and that the change goes to the org repo through their normal review, then rerun `./setup role add` to refresh the generated context.
6. **MCP servers.** Find MCP servers already configured for other agents on this machine (Claude Code, Codex, Gemini, OpenCode, Cursor, Windsurf, VS Code). List them with their source file, without values. Drop any matching `orgs/<org>/mcp/block.yml`; point out any not in `orgs/<org>/mcp/allow.yml` (project roles cannot use those). For each server the engineer keeps, propose the entry for the agent's user MCP config with every token replaced by an environment reference or a secret-store command (for omp: `"!pass show <path>"`). Show the entry; write it only after a yes.
7. **Model routing.** Explain in three lines: with routing on, subagents of project agents get their model by usage (a provider is skipped at 95% of its short window, e.g. 5 hours, or 80% of its weekly window; among the rest, the one whose short window resets soonest goes first); the project agent's own session moves down its role's list in the configured order when a provider errors or nears its limit. Run `./setup routing show` to list the providers the engineer is signed in to with their usage. Then check whether the agent's own config already routes (for omp: `omp config list | grep 'retry\.'`, and any routing extension in the agent's user extensions folder). If it does, propose keeping workspace routing off: project agents inherit that setup, and two routers would both pick subagent models. Otherwise propose, for each model role their agents use (`default` for dev, `task` for support and ops and for subagents, `slow` for reviewer, `smol` for small subagents), an ordered list of models from the signed-in providers, and run `./setup routing set <role> <provider/model> …` for each after a yes. Offer `./setup routing limits <short%> <week%>` only if they want other thresholds. Each command regenerates the agents; `./setup routing off` undoes it.
8. **Notes vault.** Ask: "Do you already have a vault?" If yes, run `./setup vault find`, let them pick one (or type a path), then `./setup vault use <path>` and confirm the folder mapping. If not, offer `./setup vault new <path>` with the default structure (outside this folder), or no vault.
9. **Verify.** Run `./setup verify` and walk through anything marked ✗.
10. **Next.** Show the engineer how to start each project agent: the `launch.omp` command in `agents/<org>/<project>/<role>/agent.yml`. With another agent, open it in `cwd` and give it `role.md` as the first message.
