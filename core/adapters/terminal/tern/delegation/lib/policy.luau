--!strict
-- Pure decisions for the omp-delegation plugin. No `tern` references: tested with the luau CLI.
local policy = {}

function policy.ownsRequest(panes: { [number]: any }, mainPane: number?): boolean
	return mainPane ~= nil and panes[mainPane] ~= nil
end

-- An active delegation is watched by the window holding Main's pane, or, if Main's pane is gone,
-- by the window holding the agent's pane.
function policy.ownsActive(panes: { [number]: any }, mainPane: number?, agentPane: number?): boolean
	return policy.ownsRequest(panes, mainPane) or (agentPane ~= nil and panes[agentPane] ~= nil)
end

function policy.deliveryAction(state: string?): string
	if state == nil or state == "exited" then
		return "start"
	end
	if state == "idle" then
		return "ask"
	end
	return "wait"
end

export type Claim = { delegationId: string, writes: boolean, cwd: string }

-- One writer per checkout: a writing request waits while another active one writes the same cwd.
function policy.canStart(req: Claim, active: { Claim }): boolean
	if not req.writes then
		return true
	end
	for _, other in active do
		if other.delegationId ~= req.delegationId and other.writes and other.cwd == req.cwd then
			return false
		end
	end
	return true
end

export type Watch = {
	done: boolean,
	cancel: boolean,
	state: string,
	pendingDecision: boolean,
	nudges: number,
	sawWorking: boolean,
}

function policy.watch(d: Watch): string
	if d.done then
		return "finish"
	end
	if d.cancel then
		return "cancel"
	end
	if d.state == "exited" then
		return "exited"
	end
	if d.state ~= "idle" or d.pendingDecision or not d.sawWorking then
		return "none"
	end
	if d.nudges == 0 then
		return "nudge"
	end
	return "stall"
end

-- One right-hand column of at most `capacity` splits: the first agent goes right of Main, each later
-- one below the lowest. A full column parks the newcomer.
function policy.place(column: { number }, mainPane: number, capacity: number): { kind: string, target: number?, dir: string? }
	if #column >= capacity then
		return { kind = "park" }
	end
	if #column == 0 then
		return { kind = "move", target = mainPane, dir = "right" }
	end
	return { kind = "move", target = column[#column], dir = "down" }
end

-- The split to park so an agent that needs the user can be shown: the oldest working one.
-- nil when there is room or every split already needs the user.
function policy.promote(column: { number }, states: { [number]: string }, capacity: number): number?
	if #column < capacity then
		return nil
	end
	for _, pane in column do
		if states[pane] == "working" then
			return pane
		end
	end
	return nil
end

-- An active file is stale when its agent pane no longer exists in any session.
function policy.isStale(act: { pane: number? }, agents: { [number]: any }): boolean
	return act.pane == nil or agents[act.pane] == nil
end

-- After a park: "done" when the pane is parked or gone, else "retry" until `max` attempts, then "giveup".
function policy.parkCheck(info: { parked: boolean? }?, attempts: number, max: number): string
	if info == nil or info.parked == true then
		return "done"
	end
	return if attempts >= max then "giveup" else "retry"
end

-- Stale files are reaped only once the agent list can be trusted: it has agents, or REAP_GRACE_MS
-- passed since load (a briefly empty list right after Tern starts must not kill live delegations).
local REAP_GRACE_MS = 5000
function policy.canReap(nowMs: number, loadedAtMs: number, agentCount: number): boolean
	return agentCount > 0 or nowMs - loadedAtMs >= REAP_GRACE_MS
end

function policy.shq(s: string): string
	return "'" .. (string.gsub(s, "'", "'\\''")) .. "'"
end

-- `<org>/<project>/<role>` as one path segment (active file, session directory). Ids may contain
-- dashes, so the parts are joined with dots to keep distinct keys distinct.
function policy.slug(agentKey: string): string
	return (string.gsub(agentKey, "/", "."))
end

-- `command` is the agent.yml launch string, already shell-quoted by the extension.
function policy.startCommand(agentKey: string, command: string, sessionDir: string, resume: string?): string
	return string.format(
		"OMP_DELEGATION_PROJECT=%s %s --session-dir %s%s",
		policy.shq(agentKey),
		command,
		policy.shq(sessionDir),
		if resume then " --resume " .. policy.shq(resume) else ""
	)
end

function policy.nudgeText(id: string): string
	return "You are working on delegation "
		.. id
		.. ". Do not end your turn to ask or to report: call request_decision to ask the user, or return_delegation with delegation_id "
		.. id
		.. " to finish."
end

return policy
