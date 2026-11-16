# Org roles

One folder per role: <role>/role.yml + role.md.
role.yml must set `extends: core:<role>`. Project roles extend the org role of the same id when one exists (`extends: org:<role>`), otherwise a core role.
Org and project roles can only tighten their parent: add denied or prompted tools, read-only paths and must-not rules; narrow mcp and skills; turn writes off. A role that loosens its parent is refused.
