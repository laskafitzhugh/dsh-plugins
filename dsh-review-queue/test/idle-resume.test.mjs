import { test } from 'node:test'
import assert from 'node:assert/strict'
import { zstdCompressSync } from 'node:zlib'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fakeLlm, systemOf, userOf } from './todo-tune-helpers.mjs'

// idle-resume.js: the periodic check of sessions that were idle for a long time (default 30 min): not working (no turn running), no running subagent
// (child session) and no background process. A session that stopped before its work was done is resumed WITHOUT asking the user; when the model is
// not sure the user gets a card (the unsure hook); one that is finished or waits for the user is left alone.
const load = () => import('../idle-resume.js')
const MIN = 60_000
const NOW = 1_800_000_000_000
const ID = (n) => '00000000-0000-4000-8000-00000000000' + n

const item = (n, over = {}) => ({ sessionId: ID(n), updatedAt: NOW - 40 * MIN, running: false, blank: false, cwd: 'D:/dev/p', agentAvailable: true, ...over })
const text = (t) => [{ type: 'text', text: t }]
const finished = (assistant, user = 'do the task') => [
  { type: 'session', id: 'x', cwd: 'D:/dev/p' },
  { type: 'turn/start', time: NOW - 50 * MIN, data: { turn: 1 } },
  { type: 'user/message', data: { content: text(user), source: { kind: 'user' } } },
  { type: 'assistant/message', data: { message: { content: text(assistant) } } },
  { type: 'turn/end', time: NOW - 41 * MIN, data: { turn: 1, reason: { kind: 'completed' } } },
]
const cutOff = () => finished('working on it').slice(0, 4)

function setup({ items = [item(1)], logs = {}, verdict = { verdict: 'done' }, idleMs, over = {} } = {}) {
  const prompts = []
  const judged = []
  const unsure = []
  const resumed = []
  const logLines = []
  let listCalls = 0
  const controller = {
    list: async () => { listCalls++; return { items } },
    prompt: async (req) => { prompts.push(req) },
  }
  const stateText = { value: undefined }
  const deps = {
    controllerOf: () => controller,
    registryOf: () => ({ archivedSessionIds: [] }),
    readLog: async (id) => (logs[id] ?? { records: finished('All done.'), torn: false }),
    judge: async (c) => { judged.push(c); return typeof verdict === 'function' ? verdict(c) : verdict },
    unsure: (c) => { unsure.push(c) },
    resumed: (c) => { resumed.push(c) },
    now: () => NOW,
    startedAt: NOW - 3600 * MIN,
    log: (line) => logLines.push(line),
    io: { read: () => stateText.value, write: (t) => { stateText.value = t } },
    ...(idleMs ? { idleMs } : {}),
    ...over,
  }
  return { deps, prompts, judged, unsure, resumed, logLines, controller, stateText, listCalls: () => listCalls }
}
const make = async (s) => { const { createIdleResumer } = await load(); return createIdleResumer(s.deps) }

// ---- background jobs ------------------------------------------------------------------------------------------------------------------

test('liveBackgroundJobs: a started job nobody collected or killed is live; a kill, a finished output, an empty job list or a restart ends it', async () => {
  const { liveBackgroundJobs } = await load()
  const started = (id, time = NOW - 100 * MIN) => ({ type: 'tool/ptc-dispatch', time, data: { name: 'pwsh', arguments: { run_in_background: true, command: 'x' }, content: text('started background job ' + id) } })
  const direct = (id) => ({ type: 'tool/result', time: NOW - 100 * MIN, data: { message: { content: text('started background job ' + id) } } })
  const call = (name, args, out = '') => ({ type: 'tool/ptc-dispatch', time: NOW - 90 * MIN, data: { name, arguments: args, content: text(out) } })
  assert.deepEqual(liveBackgroundJobs([started('pwsh-1')], { startedAt: NOW - 500 * MIN }), ['pwsh-1'])
  assert.deepEqual(liveBackgroundJobs([direct('pwsh-2')], { startedAt: NOW - 500 * MIN }), ['pwsh-2'])
  assert.deepEqual(liveBackgroundJobs([started('pwsh-1'), call('job_kill', { job_id: 'pwsh-1' }, 'killed')], { startedAt: 0 }), [])
  assert.deepEqual(liveBackgroundJobs([started('pwsh-1'), call('job_output', { job_id: 'pwsh-1' }, 'status: completed (exit 0)')], { startedAt: 0 }), [])
  assert.deepEqual(liveBackgroundJobs([started('pwsh-1'), call('job_output', { job_id: 'pwsh-1' }, 'status: running')], { startedAt: 0 }), ['pwsh-1'])
  assert.deepEqual(liveBackgroundJobs([started('pwsh-1'), started('pwsh-2'), call('job_list', {}, '(no background jobs)')], { startedAt: 0 }), [])
  assert.deepEqual(liveBackgroundJobs([started('pwsh-1', NOW - 100 * MIN)], { startedAt: NOW - 10 * MIN }), [], 'the app started after the job: its processes are gone')
  assert.deepEqual(liveBackgroundJobs([{ type: 'turn/start', data: { turn: 1 } }], { startedAt: 0 }), [])
})

// ---- which sessions are looked at -----------------------------------------------------------------------------------------------------

test('only idle top-level sessions are looked at: not running, no running child session, idle long enough, not blank, not archived, not a subagent, not too old', async () => {
  const items = [
    item(1), // idle: looked at
    item(2, { running: true }),
    item(3, { updatedAt: NOW - 10 * MIN }),
    item(4, { blank: true }),
    item(5, { origin: 'subagent', parentSessionId: ID(1) }),
    item(6), // has a running child
    item(7, { parentSessionId: ID(6), running: true }),
    item(8, { updatedAt: NOW - 5 * 24 * 3600_000 }),
    item(9), // archived
  ]
  const s = setup({ items, over: { registryOf: () => ({ archivedSessionIds: [ID(9)] }) } })
  const r = await (await make(s)).check()
  assert.equal(r.ok, true)
  assert.deepEqual(s.judged.map((c) => c.sessionId), [ID(1)])
})

test('a session whose idle time is exactly the limit is looked at, one second less is not', async () => {
  const s = setup({ items: [item(1, { updatedAt: NOW - 30 * MIN }), item(2, { updatedAt: NOW - 30 * MIN + 1000 })] })
  await (await make(s)).check()
  assert.deepEqual(s.judged.map((c) => c.sessionId), [ID(1)])
})

test('a session with a live background process is skipped without asking the model, and looked at again next time', async () => {
  const bg = [...finished('started the server'), { type: 'tool/ptc-dispatch', time: NOW - 45 * MIN, data: { name: 'pwsh', arguments: { run_in_background: true }, content: text('started background job pwsh-7') } }]
  const s = setup({ logs: { [ID(1)]: { records: bg, torn: false } } })
  const resumer = await make(s)
  const r = await resumer.check()
  assert.deepEqual([s.judged.length, s.prompts.length, r.skipped.background], [0, 0, 1])
  await resumer.check()
  assert.equal(s.listCalls(), 2)
  assert.equal(s.judged.length, 0)
})

test('at most maxPerPass sessions are read per check, the most recently idle first', async () => {
  const items = [1, 2, 3, 4, 5].map((n) => item(n, { updatedAt: NOW - (30 + n) * MIN }))
  const s = setup({ items, over: { maxPerPass: 2 } })
  await (await make(s)).check()
  assert.deepEqual(s.judged.map((c) => c.sessionId), [ID(1), ID(2)])
})

// ---- the decision -----------------------------------------------------------------------------------------------------------------------

test('a session that was cut off in a turn is resumed without asking the model, with the standard resume prompt, queued', async () => {
  const { RESUME_PROMPT } = await import('../paused.js')
  const s = setup({ logs: { [ID(1)]: { records: cutOff(), torn: false } } })
  const r = await (await make(s)).check()
  assert.equal(s.judged.length, 0)
  assert.equal(s.prompts.length, 1)
  assert.equal(s.prompts[0].sessionId, ID(1))
  assert.equal(s.prompts[0].mode, 'queue')
  assert.deepEqual(s.prompts[0].content, [{ type: 'text', text: RESUME_PROMPT }])
  assert.match(s.prompts[0].requestId, /^idle-resume-/)
  assert.deepEqual(r.resumed.map((c) => c.sessionId), [ID(1)])
  assert.deepEqual(s.resumed.map((c) => c.sessionId), [ID(1)])
})

test('the model says resume: the session gets the idle-resume prompt (it must finish or say it waits, and start nothing new) and the hook hears of it', async () => {
  const { IDLE_RESUME_PROMPT } = await load()
  const s = setup({ verdict: { verdict: 'resume', reason: 'said it would continue with step 3' } })
  const r = await (await make(s)).check()
  assert.equal(s.prompts.length, 1)
  assert.equal(s.prompts[0].content[0].text, IDLE_RESUME_PROMPT)
  assert.match(IDLE_RESUME_PROMPT, /git status/)
  assert.match(IDLE_RESUME_PROMPT, /waiting for/i)
  assert.match(IDLE_RESUME_PROMPT, /do not start anything new/i)
  assert.equal(r.resumed[0].reason, 'said it would continue with step 3')
  assert.deepEqual(s.unsure, [])
})

test('what the model is given: the title, the folder, the last request, the last reply and how the last turn ended', async () => {
  const s = setup({ logs: { [ID(1)]: { records: [...finished('Step 2 of 4 done, next is the tests.', 'implement the importer'), { type: 'session/title', data: { title: 'Importer work' } }], torn: false } } })
  await (await make(s)).check()
  const c = s.judged[0]
  assert.deepEqual([c.sessionId, c.title, c.cwd, c.lastUser, c.lastAssistant, c.endKind], [ID(1), 'Importer work', 'D:/dev/p', 'implement the importer', 'Step 2 of 4 done, next is the tests.', 'completed'])
})

test('the model says done: nothing is sent and the same idle state is not asked about again', async () => {
  const s = setup({ verdict: { verdict: 'done', reason: 'finished' } })
  const resumer = await make(s)
  await resumer.check()
  await resumer.check()
  assert.deepEqual([s.judged.length, s.prompts.length, s.unsure.length], [1, 0, 0])
})

test('the model is not sure: no prompt, the unsure hook gets the case once (the user decides), and it is not asked again for that idle state', async () => {
  const s = setup({ verdict: { verdict: 'unsure', reason: 'the last reply asks which option to take' } })
  const resumer = await make(s)
  const r = await resumer.check()
  await resumer.check()
  assert.equal(s.prompts.length, 0)
  assert.equal(s.unsure.length, 1)
  assert.deepEqual([s.unsure[0].sessionId, s.unsure[0].reason, s.unsure[0].lastWrite, s.unsure[0].cwd], [ID(1), 'the last reply asks which option to take', NOW - 40 * MIN, 'D:/dev/p'])
  assert.equal(r.asked.length, 1)
})

test('a session that ran again (new updatedAt) and went idle again is a new case', async () => {
  const items = [item(1)]
  const s = setup({ items, verdict: { verdict: 'done' } })
  const resumer = await make(s)
  await resumer.check()
  items[0] = item(1, { updatedAt: NOW - 35 * MIN })
  await resumer.check()
  assert.equal(s.judged.length, 2)
})

test('no model, a failed model call or an unusable answer ({ note }) sends nothing; a missing model is retried next time, an unusable answer is not asked again', async () => {
  const noModel = setup({ verdict: { note: 'no model available' } })
  const a = await make(noModel)
  await a.check(); await a.check()
  assert.deepEqual([noModel.prompts.length, noModel.unsure.length, noModel.judged.length], [0, 0, 2])
  const bad = setup({ verdict: { note: 'the model answered something unusable' } })
  const b = await make(bad)
  await b.check(); await b.check()
  assert.deepEqual([bad.prompts.length, bad.judged.length], [0, 1])
})

test('a session is resumed at most 3 times in 24 hours; the 4th time the user is asked instead', async () => {
  const items = [item(1)]
  const s = setup({ items, verdict: { verdict: 'resume', reason: 'unfinished' } })
  const resumer = await make(s)
  for (let i = 0; i < 4; i++) { items[0] = item(1, { updatedAt: NOW - (40 - i) * MIN }); await resumer.check() }
  assert.equal(s.prompts.length, 3)
  assert.equal(s.unsure.length, 1)
  assert.match(s.unsure[0].reason, /resumed 3 times/i)
})

test('a prompt that fails: a session DSH no longer has is dropped silently, any other failure is logged and tried again next time', async () => {
  const s = setup({ verdict: { verdict: 'resume', reason: 'r' } })
  const resumer = await make(s)
  s.controller.prompt = async () => { throw Object.assign(new Error('nope'), { code: 'session/not-found' }) }
  const r1 = await resumer.check()
  assert.deepEqual([r1.resumed.length, s.resumed.length], [0, 0])
  await resumer.check()
  assert.equal(s.judged.length, 1, 'a gone session is not looked at again')
  const t = setup({ verdict: { verdict: 'resume', reason: 'r' } })
  const again = await make(t)
  t.controller.prompt = async () => { throw new Error('busy now') }
  await again.check()
  assert.ok(t.logLines.some((l) => /busy now/.test(l)))
  t.controller.prompt = async (req) => { t.prompts.push(req) }
  await again.check()
  assert.equal(t.prompts.length, 1, 'the next check sends it')
})

test('the handled sessions survive a restart (the state is saved through io), so nothing is asked or resumed twice', async () => {
  const s = setup({ verdict: { verdict: 'resume', reason: 'r' } })
  await (await make(s)).check()
  assert.equal(s.prompts.length, 1)
  const t = setup({ verdict: { verdict: 'resume', reason: 'r' } })
  t.stateText.value = s.stateText.value
  await (await make(t)).check()
  assert.deepEqual([t.judged.length, t.prompts.length], [0, 0])
})

test('a list that fails is reported and nothing else happens; checks never overlap', async () => {
  const s = setup()
  s.controller.list = async () => { throw new Error('list down') }
  const resumer = await make(s)
  assert.deepEqual(await resumer.check(), { ok: false, error: 'list-failed' })
  const t = setup()
  let release
  const gate = new Promise((r) => { release = r })
  t.controller.list = async () => { await gate; return { items: [] } }
  const r2 = await make(t)
  const first = r2.check()
  const second = r2.check()
  release()
  assert.equal(await first, await second)
})

test('a list that times out once is asked again straight away; two failures in a row are reported and nothing else happens', async () => {
  const s = setup({ items: [item(1)], logs: { [ID(1)]: { records: cutOff(), torn: false } } })
  let calls = 0
  s.controller.list = async () => { calls++; if (calls === 1) throw new Error('The operation was aborted due to timeout'); return { items: [item(1)] } }
  const resumer = await make(s)
  const result = await resumer.check()
  assert.equal(result.ok, true)
  assert.equal(calls, 2)
  assert.equal(s.prompts.length, 1)
  const t = setup()
  let failures = 0
  t.controller.list = async () => { failures++; throw new Error('The operation was aborted due to timeout') }
  const r2 = await make(t)
  assert.deepEqual(await r2.check(), { ok: false, error: 'list-failed' })
  assert.equal(failures, 2)
  assert.equal(t.logLines.filter((l) => l.includes('listing the sessions failed')).length, 1)
})

test('without a controller or a log reader the check says so and does nothing', async () => {
  const none = setup({ over: { controllerOf: () => undefined } })
  assert.deepEqual(await (await make(none)).check(), { ok: false, error: 'no-controller' })
  const s = setup({ over: { readLog: async () => undefined } })
  const r = await (await make(s)).check()
  assert.equal(s.judged.length, 0)
  assert.equal(r.skipped.unreadable, 1)
})

// ---- the model judge --------------------------------------------------------------------------------------------------------------------

test('createIdleJudge: the model answer { verdict, reason } is read, also inside a code fence or after some words', async () => {
  const { createIdleJudge } = await load()
  const c = { title: 'T', cwd: 'D:/dev/p', lastUser: 'build it', lastAssistant: 'Part 1 done; continuing with part 2.', endKind: 'completed', danglingCalls: [] }
  for (const answer of ['{"verdict":"resume","reason":"part 2 is left"}', '```json\n{"verdict":"resume","reason":"part 2 is left"}\n```', 'Sure: {"verdict": "resume", "reason": "part 2 is left"}']) {
    const seen = {}
    const judge = createIdleJudge({ llm: fakeLlm({ answer, seen }) })
    assert.deepEqual(await judge(c), { verdict: 'resume', reason: 'part 2 is left' }, answer)
    assert.match(userOf(seen), /Part 1 done; continuing with part 2\./)
    assert.match(userOf(seen), /build it/)
    assert.match(userOf(seen), /Importer|T\b/)
  }
})

test('createIdleJudge: the system prompt defines resume, done and unsure, and tells the model that a reply waiting for the user is done or unsure', async () => {
  const { createIdleJudge } = await load()
  const seen = {}
  await createIdleJudge({ llm: fakeLlm({ answer: '{"verdict":"done"}', seen }) })({ title: '', cwd: '', lastUser: 'a', lastAssistant: 'b', endKind: 'completed', danglingCalls: [] })
  const system = systemOf(seen)
  for (const word of ['resume', 'done', 'unsure', 'JSON']) assert.match(system, new RegExp(word))
  assert.match(system, /waiting for (an answer|the user)/i)
})

test('createIdleJudge: an unknown verdict, garbage or an empty answer is unusable; no llm or no model is "no model available"; a provider failure gives a generic note', async () => {
  const { createIdleJudge } = await load()
  const c = { title: '', cwd: '', lastUser: 'a', lastAssistant: 'b', endKind: 'completed', danglingCalls: [] }
  for (const answer of ['', 'I think it is done', '{"verdict":"maybe"}', '[]']) {
    assert.deepEqual(await createIdleJudge({ llm: fakeLlm({ answer }) })(c), { note: 'the model answered something unusable' }, JSON.stringify(answer))
  }
  assert.deepEqual(await createIdleJudge({ llm: undefined })(c), { note: 'no model available' })
  assert.deepEqual(await createIdleJudge({ llm: fakeLlm({ noModels: true }) })(c), { note: 'no model available' })
  const failed = await createIdleJudge({ llm: fakeLlm({ fail: true, failMessage: 'secret-key-abc' }) })(c)
  assert.ok(failed.note && !/secret-key-abc/.test(failed.note), failed.note)
})

test('createIdleJudge: a reason is cut at 300 characters; a missing reason is allowed', async () => {
  const { createIdleJudge } = await load()
  const c = { title: '', cwd: '', lastUser: 'a', lastAssistant: 'b', endKind: 'completed', danglingCalls: [] }
  const long = await createIdleJudge({ llm: fakeLlm({ answer: JSON.stringify({ verdict: 'unsure', reason: 'r'.repeat(900) }) }) })(c)
  assert.equal(long.reason.length, 300)
  assert.deepEqual(await createIdleJudge({ llm: fakeLlm({ answer: '{"verdict":"done"}' }) })(c), { verdict: 'done' })
})

// ---- reading a log ----------------------------------------------------------------------------------------------------------------------

test('createLogReader reads the records of a session log under the sessions folder, nothing for a missing, a too big or an unknown one', async (t) => {
  const { createLogReader } = await load()
  const root = mkdtempSync(join(tmpdir(), 'rq-idle-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const dir = join(root, '--D--dev--p--', ID(1))
  mkdirSync(dir, { recursive: true })
  const lines = [{ type: 'session', id: ID(1), cwd: 'D:/dev/p' }, { type: 'turn/start', data: { turn: 1 } }]
  writeFileSync(join(dir, 'session.v4.jsonl.zstd'), zstdCompressSync(Buffer.from(lines.map((l) => JSON.stringify(l)).join('\n') + '\n')))
  const read = createLogReader({ root })
  const got = await read(ID(1))
  assert.deepEqual(got.records.map((r) => r.type), ['session', 'turn/start'])
  assert.equal(await read(ID(2)), undefined)
  assert.equal(await createLogReader({ root, maxBytes: 5 })(ID(1)), undefined)
  assert.equal(await read('../etc'), undefined)
})

test('createLogStatter gives the last write time of a session log without reading it, and nothing for a missing, an unknown or an unstattable one', async (t) => {
  const { createLogStatter } = await load()
  const root = mkdtempSync(join(tmpdir(), 'rq-idle-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const dir = join(root, '--D--dev--p--', ID(1))
  mkdirSync(dir, { recursive: true })
  const file = join(dir, 'session.v4.jsonl.zstd')
  writeFileSync(file, 'not a log, never read')
  const lastWriteOf = createLogStatter({ root })
  assert.equal(await lastWriteOf(ID(1)), Math.round(statSync(file).mtimeMs))
  assert.equal(await lastWriteOf(ID(2)), undefined)
  assert.equal(await lastWriteOf('../etc'), undefined)
  assert.equal(await createLogStatter({ root, io: { stat: async () => { throw new Error('denied') } } })(ID(1)), undefined)
})
