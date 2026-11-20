local policy = require("../lib/policy")

local failures = 0
local function check(name: string, ok: boolean)
	if ok then
		print("ok   " .. name)
	else
		failures += 1
		print("FAIL " .. name)
	end
end

-- ownership
check("owns a request whose Main pane is in this window", policy.ownsRequest({ [7] = {} }, 7))
check("ignores a request from another window", not policy.ownsRequest({ [7] = {} }, 8))
check("ignores a request without a Main pane", not policy.ownsRequest({ [7] = {} }, nil))
check("keeps watching when Main's pane closed but the agent's pane is here", policy.ownsActive({ [9] = {} }, 7, 9))
check("does not watch an active delegation living in another window", not policy.ownsActive({ [1] = {} }, 7, 9))

-- delivery
check("starts an agent when none exists", policy.deliveryAction(nil) == "start")
check("restarts an exited agent", policy.deliveryAction("exited") == "start")
check("asks an idle agent", policy.deliveryAction("idle") == "ask")
check("waits for a working agent", policy.deliveryAction("working") == "wait")
check("never types into an agent waiting on an approval", policy.deliveryAction("waiting_input") == "wait")

-- writer lock per checkout
local function req(id: string, writes: boolean, cwd: string)
	return { delegationId = id, writes = writes, cwd = cwd }
end
check("a second writer on the same cwd is queued", not policy.canStart(req("b", true, "/w/kb"), { req("a", true, "/w/kb") }))
check("the queued writer starts once the first finished", policy.canStart(req("b", true, "/w/kb"), {}))
check("a read-only role starts alongside a writer", policy.canStart(req("b", false, "/w/kb"), { req("a", true, "/w/kb") }))
check("a writer starts alongside a read-only role", policy.canStart(req("b", true, "/w/kb"), { req("a", false, "/w/kb") }))
check("writers on different cwd both start", policy.canStart(req("b", true, "/w/shop"), { req("a", true, "/w/kb") }))
check("a request never blocks itself", policy.canStart(req("a", true, "/w/kb"), { req("a", true, "/w/kb") }))

-- watch
local function w(over)
	local d = { done = false, cancel = false, state = "idle", pendingDecision = false, nudges = 0, sawWorking = true }
	for k, v in over do
		d[k] = v
	end
	return policy.watch(d)
end
check("a done response finishes", w({ done = true, state = "working" }) == "finish")
check("cancel wins over everything but done", w({ cancel = true, state = "working" }) == "cancel")
check("an exited agent is reported", w({ state = "exited" }) == "exited")
check("idle before it ever worked: no nudge", w({ sawWorking = false }) == "none")
check("idle after working, no protocol call: one nudge", w({}) == "nudge")
check("idle again after the nudge: stalled", w({ nudges = 1 }) == "stall")
check("an open decision is authoritative over idle", w({ pendingDecision = true }) == "none")
check("working is left alone", w({ state = "working" }) == "none")

-- layout: one right-hand column, stacked top to bottom, capacity 3
local first = policy.place({}, 7, 3)
check("first agent goes right of Main", first.kind == "move" and first.target == 7 and first.dir == "right")
local second = policy.place({ 11 }, 7, 3)
check("second agent stacks below the first", second.kind == "move" and second.target == 11 and second.dir == "down")
local third = policy.place({ 11, 12 }, 7, 3)
check("third agent stacks below the lowest", third.kind == "move" and third.target == 12 and third.dir == "down")
-- the middle agent (12) parked: the column is {11, 13}; the next one goes below 13
local after = policy.place({ 11, 13 }, 7, 3)
check("after the middle one parks, the next goes below the last", after.kind == "move" and after.target == 13 and after.dir == "down")
check("an emptied column starts again right of Main", policy.place({}, 7, 3).dir == "right")
check("a full column parks the newcomer", policy.place({ 11, 12, 13 }, 7, 3).kind == "park")
check(
	"promotion parks the oldest working split",
	policy.promote({ 11, 12, 13 }, { [11] = "waiting_input", [12] = "working", [13] = "working" }, 3) == 12
)
check("no promotion needed below capacity", policy.promote({ 11 }, { [11] = "working" }, 3) == nil)
check(
	"no victim when every split needs the user",
	policy.promote({ 11, 12, 13 }, { [11] = "waiting_input", [12] = "waiting_input", [13] = "waiting_input" }, 3) == nil
)

-- stale active files
local live = { [9] = { pane = 9 } }
check("an active file whose agent pane is gone is stale", policy.isStale({ pane = 4 }, live))
check("an active file without a pane is stale", policy.isStale({}, live))
check("an active file with a live agent pane is not stale", not policy.isStale({ pane = 9 }, live))

-- a park that did not take is retried a few ticks, then reported
check("a parked pane needs no retry", policy.parkCheck({ parked = true }, 1, 6) == "done")
check("a pane that is gone needs no retry", policy.parkCheck(nil, 1, 6) == "done")
check("a pane still in its tab is parked again", policy.parkCheck({ parked = false }, 1, 6) == "retry")
check("a pane with no parked flag counts as shown", policy.parkCheck({}, 5, 6) == "retry")
check("a pane still shown after the last attempt is reported", policy.parkCheck({ parked = false }, 6, 6) == "giveup")

-- reaping stale files waits for a populated agent list or 5 s after load
check("no reaping right after load while the agent list is empty", not policy.canReap(1000, 0, 0))
check("no reaping 4.9 s after load while the list is empty", not policy.canReap(4900, 0, 0))
check("reaping once the list has agents", policy.canReap(100, 0, 2))
check("reaping 5 s after load even with an empty list", policy.canReap(5000, 0, 0))

-- naming and start command
check("key slug is org.project.role (no collision with dashes in ids)", policy.slug("acme/shop/dev") == "acme.shop.dev")
check("keys with dashes do not collide", policy.slug("acme-shop/api/dev") ~= policy.slug("acme/shop-api/dev"))
check(
	"start command: env, launch string, session dir",
	policy.startCommand("acme/shop/dev", "omp --model x", "/s/acme-shop-dev", nil)
		== "OMP_DELEGATION_PROJECT='acme/shop/dev' omp --model x --session-dir '/s/acme-shop-dev'"
)
check(
	"start command resumes the newest session",
	policy.startCommand("acme/shop/dev", "omp", "/s/d", "/s/d/1.jsonl")
		== "OMP_DELEGATION_PROJECT='acme/shop/dev' omp --session-dir '/s/d' --resume '/s/d/1.jsonl'"
)

-- shell quoting
check("quotes a plain path", policy.shq("/a b/c") == "'/a b/c'")
check("quotes a path with a single quote", policy.shq("/x/it's") == "'/x/it'\\''s'")

check(
	"the nudge names the delegation and both tools",
	string.find(policy.nudgeText("dlg_X"), "dlg_X", 1, true) ~= nil
		and string.find(policy.nudgeText("dlg_X"), "request_decision", 1, true) ~= nil
		and string.find(policy.nudgeText("dlg_X"), "return_delegation", 1, true) ~= nil
)

if failures > 0 then
	error(failures .. " policy test(s) failed")
end
