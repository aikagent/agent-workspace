# agent-workspace

Clone this repo, run `./setup`, and get an AI-assisted engineering workflow for the projects you work on: shared rules, roles per project, generated project agents, MCP servers and a notes vault.

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
4. hands over to omp with `/workspace-setup`, which guides you through orgs, projects, roles, MCP servers and your notes vault. Workspace changes go through `./setup` commands after your yes; MCP entries for your agent's own config are shown and written only after your yes.

## Commands

| Command | Does |
|---|---|
| `./setup` | Bootstrap, then guided setup in omp |
| `./setup check` | Shows which tools are installed |
| `./setup org add <git-url>` | Clones an org repo into `orgs/<id>/` |
| `./setup project add <org>/<project>` | Clones the project's repos into `projects/<org>/<name>/` |
| `./setup role add <org>/<project> <role>` | Resolves the role (core → org → project) and writes the agent to `agents/<org>/<project>/<role>/`: `role.md` (context, rules, instructions), `overlay.yml` (tool approvals for omp), `agent.yml` (with the launch command) |
| `./setup vault find` / `use <path>` / `new <path>` | Uses an existing notes vault, or creates one with the default structure |
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
projects/   (gitignored) your cloned projects
agents/     (gitignored) generated project agents
workspace.yml (gitignored) your choices
```

## Three levels of roles

A role is defined in **core**, can be specialised by your **org** (`orgs/<org>/roles/`) and again by a **project** (`orgs/<org>/projects/<project>/roles/`). Each level points to its parent with `extends:`, and a project role cannot skip an org role of the same id. Lower levels can only tighten: add denied or prompted tools, read-only paths and must-not rules, turn writes off, or narrow MCP servers and skills. A role that tries to loosen its parent is refused.

On omp, denied and prompted tools are enforced by the generated `overlay.yml` (a read-only role also denies edit, write and ast_edit). Must-not rules, read-only paths and MCP lists are written into `role.md` as instructions. On other agents, everything is instructions.

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
