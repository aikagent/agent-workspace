# agent-workspace

Clone this repo, run `./setup`, and get an AI-assisted engineering workflow for the projects you work on: shared rules, roles per project, generated project agents, MCP servers, usage-based model routing and a notes vault.

This repo holds **only structure and the generic workflow**. Your organisation's data lives in its own private org repo; your personal choices stay on your machine. Nothing is shared back.

## Quick start

```sh
git clone <this-repo> agent-workspace
cd agent-workspace
./setup
```

`./setup` needs [bun](https://bun.sh) and git. It then:
1. checks your tools,
2. asks for your AI provider and agent (omp by default; any other agent gets a generic setup),
3. installs omp if missing (after a yes), signs you in, runs a one-line smoke test,
4. hands over to omp with `/workspace-setup`, which guides you through orgs, projects, roles, MCP servers, model routing and your notes vault. Workspace changes go through `./setup` commands after your yes; MCP entries for your agent's own config are shown and written only after your yes.

## Commands

| Command | Does |
|---|---|
| `./setup` | Bootstrap, then guided setup in omp |
| `./setup check` | Shows which tools are installed |
| `./setup org add <git-url>` | Clones an org repo into `orgs/<id>/` |
| `./setup project add <org>/<project>` | Sets up the project's repos in `projects/<org>/<name>/`: clones each one, or creates an empty folder for a repo without a url; existing folders are left as they are |
| `./setup role add <org>/<project> <role>` | Resolves the role (core → org → project) and writes the agent to `agents/<org>/<project>/<role>/`: `role.md` (context, rules, instructions), `overlay.yml` (tool approvals and MCP isolation for omp), `agent.yml` (with the launch command and model) |
| `./setup vault find` / `use <path>` / `new <path>` | Uses an existing notes vault, or creates one with the default structure |
| `./setup routing show` / `set <role> <provider/model>…` / `limits <short%> <week%>` / `off` | Shows your providers' usage; sets the models per omp model role for usage-based routing (regenerates the agents) |
| `./setup verify` | Checks everything on disk |

## Layout

```
setup                   entry point
AGENTS.md               workflow rules every agent here follows
core/
  workflow/roles/       core roles: dev, support, reviewer, ops
  commands/workspace-setup.md   the guided /workspace-setup (linked from .omp/commands/)
  adapters/agent/       how generated agents run on omp, or on any other agent
  templates/org/        start your org repo from this
  templates/notes/      default notes vault structure
  templates/workspace.example.yml
  wizard/               the setup CLI and its tests
orgs/       (gitignored) your org repos
projects/   (gitignored) your project folders
agents/     (gitignored) generated project agents
workspace.yml (gitignored) your choices
```

## Three levels of roles

A role is defined in **core**, can be specialised by your **org** (`orgs/<org>/roles/`) and again by a **project** (`orgs/<org>/projects/<project>/roles/`). Each level points to its parent with `extends:`, and a project role cannot skip an org role of the same id. Lower levels can only tighten: add denied or prompted tools, read-only paths and must-not rules, turn writes off, or narrow MCP servers and skills. A role that tries to loosen its parent is refused.

On omp, denied and prompted tools are enforced by the generated `overlay.yml` (a read-only role also denies edit, write and ast_edit). The overlay also stops the agent from loading the repo's own MCP config (`.mcp.json` and the like), which the org's MCP lists do not cover; agents get only your user-level MCP servers. Must-not rules, read-only paths and MCP lists are written into `role.md` as instructions. On other agents, everything is instructions.

Each role has a model tier (`default`, `task`, `review`). On omp it maps to your model roles `@default`, `@task` and `@slow`; set `models:` in `workspace.yml` to pick other models per tier.

## Model routing

Off by default: project agents then use your own omp setup. `./setup routing set <role> <provider/model> …` lists, for one omp model role, the models to use in order, across the providers you are signed in to. With routing on:
- **Subagents** get their model from a router (`core/adapters/agent/omp/usage-router/`, loaded with `omp -e`): a provider is skipped at 95% of its short window (e.g. 5 hours) or 80% of its weekly window, and among the rest the one whose short window resets soonest goes first, since that quota expires unused otherwise. A provider with several accounts stays in while one of them is under the limits; providers that report no usage are skipped. Change the thresholds with `./setup routing limits`.
- **The agent's own session** starts on your model for its role and moves down the role's list, in the order you gave: on a provider error such as a usage limit, and before a request once the provider's most-used window has less than `100 − short`% left (omp's `retry.fallbackChains` and usage-aware fallback, written to `overlay.yml`). Your other global fallback chains stay as they are.

If your omp setup already routes subagents with its own extension, keep workspace routing off: both routers would act on every spawn.

## Set up your org repo

Copy `core/templates/org/` into a new private repo, fill in `org.yml`, add one folder per project under `projects/` (with `project.yml`, `context.md`, `glossary.md`), add org roles and skills, the MCP allow and block lists, and `denywords.txt` (words that must never appear in this tool's repo; `./setup verify` checks them). Then `./setup org add <its-url>`.

## Status

Early. Works today: bootstrap with omp, org/project/role/vault commands, role resolution with tighten-only checks. Planned: Tern split panes and delegation between a main session and project agents, more agent adapters.

## Develop

```sh
bun test core/wizard/test
AGENT_WORKSPACE_ROOT=/tmp/ws ./setup …   # run the commands against another workspace folder
```

## License

MIT, see [LICENSE](LICENSE).
