-- Wiring only: decisions live in lib/policy.luau. Mailbox layout: see the extension's mailbox.ts.
local tern = require("tern")
local policy = require("./lib/policy")

local HOME = tern.getenv("HOME") or ""
-- Fixed on purpose: Tern.app's environment differs from the shell's, so no env override here.
local ROOT = HOME .. "/.agent-workspace/delegation"
local SESSIONS = HOME .. "/.agent-workspace/sessions"
local POLL_MS = 500
local CAPACITY = 3 -- splits in the agent column; further active agents run parked
local LOADED_AT = tern.now()
local RETRY_MS = 30000 -- recheck a request that no pane of this window owns after this long
local MAX = 65536

local function p(...: string): string
	return table.concat({ ... }, "/")
end

local function readJson(file: string): any
	if not tern.fs.exists(file) then
		return nil
	end
	local ok, value = pcall(function()
		return tern.json.decode(tern.fs.read(file, MAX))
	end)
	return if ok then value else nil
end

local function writeJson(file: string, value: any)
	tern.fs.write(file, tern.json.encode(value))
end

-- Wall-clock milliseconds when the sandbox has os.time (event names sort with the extension's), else uptime.
local function stamp(): number
	return if os and os.time then os.time() * 1000 else math.floor(tern.now())
end

local seq = 0
local function event(id: string, ev: any)
	seq += 1
	local dir = p(ROOT, "events", id)
	tern.fs.mkdir(dir)
	local base = string.format("%013d-plugin-%06d", stamp(), seq)
	writeJson(p(dir, base .. ".json"), ev)
	tern.fs.write(p(dir, base .. ".ready"), "")
end

local function setStatus(id: string, status: string, detail: string?)
	local file = p(ROOT, "status", id .. ".json")
	local prev = readJson(file)
	if prev and prev.status == status and prev.detail == detail then
		return
	end
	writeJson(file, { status = status, detail = detail })
	event(id, { kind = "status", status = status, detail = detail })
end

local function respond(id: string, agentKey: string, status: string, reason: string, lastMessage: string?)
	if tern.fs.exists(p(ROOT, "responses", id .. ".done")) then
		return
	end
	writeJson(p(ROOT, "responses", id .. ".json"), {
		protocol = "omp-delegation/v1",
		delegationId = id,
		project = agentKey,
		status = status,
		reason = reason,
		lastMessage = lastMessage,
	})
	tern.fs.write(p(ROOT, "responses", id .. ".done"), "")
end

local function pendingDecision(id: string): boolean
	local dir = p(ROOT, "events", id)
	if not tern.fs.exists(dir) then
		return false
	end
	local asked, answered = {}, {}
	for _, name in tern.fs.list(dir) do
		local base = string.match(name, "^(.+)%.ready$")
		local ev = if base then readJson(p(dir, base .. ".json")) else nil
		if ev and ev.kind == "decision_request" then
			asked[ev.decisionId] = true
		elseif ev and ev.kind == "decision_answer" then
			answered[ev.decisionId] = true
		end
	end
	for decisionId in asked do
		if not answered[decisionId] then
			return true
		end
	end
	return false
end

local function newestSession(dir: string): string?
	local newest = nil
	for _, name in tern.fs.list(dir) do
		if string.match(name, "%.jsonl$") and (newest == nil or name > newest) then
			newest = name
		end
	end
	return if newest then p(dir, newest) else nil
end

local function activeClaims(): { any }
	local list = {}
	for _, name in tern.fs.list(p(ROOT, "active")) do
		local act = if string.match(name, "%.json$") then readJson(p(ROOT, "active", name)) else nil
		if act then
			table.insert(list, act)
		end
	end
	return list
end

-- The right-hand column of this Main, top to bottom, in tern.kv; pruned to live, unparked panes.
local function column(panes: { [number]: any }, mainPane: number): { number }
	local kept = {}
	for _, pane in tern.kv.get("column:" .. mainPane) or {} do
		local info = panes[pane]
		if info and not info.parked then
			table.insert(kept, pane)
		end
	end
	return kept
end

local function saveColumn(mainPane: number, col: { number })
	tern.kv.set("column:" .. mainPane, tern.json.array(col))
end

-- Parks that must be verified on the next ticks: pane -> { attempts, reason }.
local PARK_ATTEMPTS = 6
local pendingPark = {}

local function tryPark(cx: any, pane: number, attempts: number)
	local ok, reason = cx.layout:park(pane)
	if not ok then
		tern.log.warn("omp-delegation: park of pane " .. tostring(pane) .. " refused: " .. tostring(reason))
	end
	pendingPark[pane] = { attempts = attempts, reason = if ok then nil else tostring(reason) }
end

local function hide(cx: any, panes: { [number]: any }, mainPane: number, pane: number)
	tryPark(cx, pane, 1)
	local kept = {}
	for _, x in column(panes, mainPane) do
		if x ~= pane then
			table.insert(kept, x)
		end
	end
	saveColumn(mainPane, kept)
end

-- Puts `pane` in the column. Returns false when it stays parked because the column is full;
-- `needsUser` lets it replace (park) the oldest working split.
local function show(cx: any, panes: { [number]: any }, mainPane: number, pane: number, needsUser: boolean): boolean
	local col = column(panes, mainPane)
	for _, x in col do
		if x == pane then
			return true
		end
	end
	local spot = policy.place(col, mainPane, CAPACITY)
	if spot.kind == "park" and needsUser then
		local states = {}
		for _, a in cx.agents:list() do
			states[a.pane] = a.state
		end
		local victim = policy.promote(col, states, CAPACITY)
		if victim then
			hide(cx, panes, mainPane, victim)
			col = column(panes, mainPane)
			spot = policy.place(col, mainPane, CAPACITY)
		end
	end
	local info = panes[pane]
	if spot.kind == "park" then
		if not (info and info.parked) then
			tryPark(cx, pane, 1)
		end
		return false
	end
	pendingPark[pane] = nil
	if info and info.parked then
		cx.layout:unpark(pane, { focus = false })
		info.parked = false
	end
	-- start/unpark steal focus: place without focus, then give it back to Main.
	cx.layout:move(pane, spot.target, spot.dir, { focus = false })
	table.insert(col, pane)
	saveColumn(mainPane, col)
	if panes[mainPane] then
		cx.layout:focus(mainPane)
	end
	return true
end

-- Per-VM memory so a tick skips what is settled: requests already claimed (here or by another window)
-- or not owned by this window (retried after RETRY_MS), and claims already consumed.
local claimed, consumed, retryAt = {}, {}, {}

-- A request is claimed by the window holding its Main pane. The claim carries what the queue needs.
local function claimNew(panes: { [number]: any })
	for _, name in tern.fs.list(p(ROOT, "requests")) do
		local id = string.match(name, "^(dlg_[0-9A-Z]+)%.ready$")
		if id and not claimed[id] and (retryAt[id] or 0) <= tern.now() then
			if tern.fs.exists(p(ROOT, "claims", id .. ".json")) then
				claimed[id] = true
			else
				local req = readJson(p(ROOT, "requests", id .. ".json"))
				if req and policy.ownsRequest(panes, req.parent and req.parent.ternPane) then
					writeJson(p(ROOT, "claims", id .. ".json"), { claimedAt = stamp(), agentKey = req.agentKey, mainPane = req.parent.ternPane })
					claimed[id] = true
					setStatus(id, "queued", nil)
				else
					retryAt[id] = tern.now() + RETRY_MS
				end
			end
		end
	end
end

local function consume(id: string)
	tern.fs.write(p(ROOT, "claims", id .. ".delivered"), "")
	consumed[id] = true
end

-- Returns true when the request was consumed (started, asked, cancelled, failed or gone).
local function deliver(cx: any, panes: { [number]: any }, agents: { [number]: any }, id: string, agentKey: string): boolean
	local req = readJson(p(ROOT, "requests", id .. ".json"))
	if not req then
		consume(id)
		return true
	end
	if tern.fs.exists(p(ROOT, "requests", id .. ".cancel")) then
		respond(id, agentKey, "cancelled", "cancelled before it started", nil)
		consume(id)
		return true
	end
	local mainPane = req.parent.ternPane
	if not policy.canStart(req, activeClaims()) then
		setStatus(id, "queued", "another agent is writing in " .. req.cwd)
		return false
	end
	local pane = tern.kv.get("agent:" .. agentKey)
	local agent = if pane then agents[pane] else nil
	local action = policy.deliveryAction(if agent then agent.state else nil)
	if action == "wait" then
		setStatus(id, "queued", agentKey .. " agent is busy")
		return false
	end
	local ok, err
	local placed = true
	if action == "start" then
		if agent then
			pcall(function()
				cx.agents:stop(pane) -- the exited program's block would otherwise stay in the column
			end)
		end
		local dir = p(SESSIONS, policy.slug(agentKey))
		tern.fs.mkdir(dir)
		local cmd = policy.startCommand(agentKey, req.command, dir, newestSession(dir))
		ok, err = pcall(function()
			pane = cx.agents:start({ prompt = req.handoff, cwd = req.cwd, command = cmd, how = "split" })
		end)
		if ok then
			tern.kv.set("agent:" .. agentKey, pane)
			panes[pane] = { pane = pane }
		end
	else
		ok, err = pcall(function()
			placed = show(cx, panes, mainPane, pane, false) -- unpark before asking
			cx.agents:ask(pane, req.handoff)
		end)
	end
	if not ok then
		tern.kv.set("agent:" .. agentKey, nil)
		respond(id, agentKey, "agent_exited", "could not reach the agent: " .. tostring(err), nil)
		consume(id)
		return true
	end
	-- The lock is taken only now that the agent has the work; the claim is consumed before any layout step.
	writeJson(p(ROOT, "active", policy.slug(agentKey) .. ".json"), {
		delegationId = id,
		project = agentKey,
		agentKey = agentKey,
		writes = req.writes,
		cwd = req.cwd,
		pane = pane,
		mainPane = mainPane,
		nudges = 0,
		sawWorking = false,
	})
	consume(id)
	if action == "start" then
		placed = show(cx, panes, mainPane, pane, false)
	end
	if not placed then
		cx:toast("info", agentKey .. " is running parked", "the agent column is full")
	end
	setStatus(id, "dispatched", nil)
	return true
end

-- The last 1000 messages as they are; the extension slices from the handoff header. The marker comes last.
local function dumpTranscript(cx: any, act: any)
	local ok, msgs = pcall(function()
		return cx.agents:transcript(act.pane, { last = 1000 })
	end)
	local dump = if ok and msgs then msgs else tern.json.array()
	writeJson(p(ROOT, "responses", act.delegationId .. ".transcript.json"), dump)
	tern.fs.write(p(ROOT, "responses", act.delegationId .. ".transcript.ready"), "")
end

local function watch(cx: any, panes: { [number]: any }, agents: { [number]: any }, reap: boolean, file: string)
	local act = readJson(file)
	if not act then
		return
	end
	-- `agents` spans every session: a gone pane means nobody can finish this delegation, whoever owns it.
	-- The first tick after a load or reload runs this for every leftover active file.
	if policy.isStale(act, agents) then
		if not reap then
			return
		end
		respond(act.delegationId, act.project or act.agentKey or "", "agent_exited", "the agent's pane is gone", nil)
		tern.fs.remove(file)
		return
	end
	if not policy.ownsActive(panes, act.mainPane, act.pane) then
		return
	end
	local id = act.delegationId
	local agent = agents[act.pane]
	local state = if agent then agent.state else "exited"
	if state == "working" or state == "waiting_input" then
		act.sawWorking = true
	end
	local pending = pendingDecision(id)
	local verdict = policy.watch({
		done = tern.fs.exists(p(ROOT, "responses", id .. ".done")),
		cancel = tern.fs.exists(p(ROOT, "requests", id .. ".cancel")),
		state = state,
		pendingDecision = pending,
		nudges = act.nudges,
		sawWorking = act.sawWorking,
	})
	local last = if agent then agent.last_message else nil
	if verdict == "finish" then
		dumpTranscript(cx, act)
		hide(cx, panes, act.mainPane, act.pane)
		setStatus(id, "finished", nil)
	elseif verdict == "cancel" then
		cx.agents:interrupt(act.pane)
		respond(id, act.project, "cancelled", "cancelled by the user", last)
		hide(cx, panes, act.mainPane, act.pane)
	elseif verdict == "exited" then
		respond(id, act.project, "agent_exited", "the agent's program exited", last)
	elseif verdict == "stall" then
		respond(id, act.project, "stalled", "idle twice without request_decision or return_delegation", last)
		hide(cx, panes, act.mainPane, act.pane)
	else
		if verdict == "nudge" then
			cx.agents:ask(act.pane, policy.nudgeText(id))
			act.nudges += 1
			act.sawWorking = false
			setStatus(id, "nudged", "idle without request_decision or return_delegation")
		elseif state == "waiting_input" or pending then
			if not show(cx, panes, act.mainPane, act.pane, true) and not act.toasted then
				act.toasted = true
				cx:toast("info", act.project .. " needs you but the column is full", "it is parked; free a split")
			end
			setStatus(id, "awaiting_you", if pending then "decision" else "approval in its pane")
		else
			setStatus(id, "working", nil)
		end
		writeJson(file, act)
		return
	end
	tern.fs.remove(file) -- the agent lock is released
end

-- Heads of the per-agent queues: the oldest undelivered claimed request of each agent key.
local function deliverQueued(cx: any, panes: { [number]: any }, agents: { [number]: any })
	local seen = {}
	for _, name in tern.fs.list(p(ROOT, "claims")) do
		local id = string.match(name, "^(dlg_[0-9A-Z]+)%.json$")
		if id and not consumed[id] then
			if tern.fs.exists(p(ROOT, "claims", id .. ".delivered")) then
				consumed[id] = true
			else
				local claim = readJson(p(ROOT, "claims", name))
				if claim and claim.agentKey and not seen[claim.agentKey] and policy.ownsRequest(panes, claim.mainPane) then
					seen[claim.agentKey] = true
					local busy = tern.fs.exists(p(ROOT, "active", policy.slug(claim.agentKey) .. ".json"))
					if not busy then
						deliver(cx, panes, agents, id, claim.agentKey)
					end
				end
			end
		end
	end
end

local function tick(cx: any)
	-- The extension creates the runtime folders (with their permissions) when it writes a request; tern.fs.mkdir
	-- takes no mode and would create the parents too, so the plugin only works inside what exists.
	if not tern.fs.exists(p(ROOT, "requests")) or not tern.fs.exists(p(ROOT, "active")) then
		return
	end
	local panes = {}
	for _, info in cx.session:panes() do
		panes[info.pane] = info
	end
	local agents, agentCount = {}, 0
	for _, a in cx.agents:list() do
		agents[a.pane] = a
		agentCount += 1
	end
	local reap = policy.canReap(tern.now(), LOADED_AT, agentCount)
	-- A park that did not take is repeated for a few ticks, then reported with Tern's reason.
	for pane, pending in pendingPark do
		local verdict = policy.parkCheck(panes[pane], pending.attempts, PARK_ATTEMPTS)
		if verdict == "done" then
			pendingPark[pane] = nil
		elseif verdict == "retry" then
			tryPark(cx, pane, pending.attempts + 1)
		else
			pendingPark[pane] = nil
			tern.log.warn("omp-delegation: pane " .. tostring(pane) .. " is still shown after " .. PARK_ATTEMPTS .. " park attempts")
			cx:toast("error", "omp delegation: could not park an agent", pending.reason or "the pane stayed in its tab")
		end
	end
	claimNew(panes)
	for _, name in tern.fs.list(p(ROOT, "active")) do
		if string.match(name, "%.json$") then
			watch(cx, panes, agents, reap, p(ROOT, "active", name))
		end
	end
	deliverQueued(cx, panes, agents)
end

local lastError = nil
local function loop()
	tern.timer(POLL_MS, function(cx)
		if cx then
			local ok, err = pcall(tick, cx)
			if not ok and err ~= lastError then
				lastError = err
				cx:toast("error", "omp delegation: tick failed", tostring(err))
			end
		end
		loop()
	end)
end

-- `tern plugin reload` does not re-run window_start, so start from the load itself as well; once only.
local running = false
local function init()
	if not running then
		running = true
		loop()
	end
end

tern.on("window_start", init)
init()
