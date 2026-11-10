import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createStore } from '../store.js'
import { createIdleAsker, createSleepTracker, ASK_PROMPT, isPrTitle, lastActivityAt } from '../idle-ask.js'

const H = 3600_000
const memIo = () => { const io = { text: undefined, read: () => io.text, write: (t) => { io.text = t } }; return io }
const rig = (items, extra = {}) => {
  const prompts = []
  const archived = []
  let t = 10 * H
  const store = createStore()
  const asker = createIdleAsker({
    controllerOf: () => ({ list: async () => ({ items }), prompt: async (r) => { prompts.push(r) } }),
    registryOf: () => ({ archivedSessionIds: [], archiveSession: async (id, o) => { archived.push([id, o]) } }),
    store, now: () => t, io: memIo(), ...extra,
  })
  return { asker, prompts, archived, store, setNow: (n) => { t = n } }
}
const S = (id, updatedAt, more = {}) => ({ sessionId: id, updatedAt, running: false, ...more })

test('asks a session idle for over an hour, once per idle state', async () => {
  const r = rig([S('a', 10 * H - 61 * 60_000), S('b', 10 * H - 59 * 60_000)])
  assert.deepEqual((await r.asker.check()).asked, ['a'])
  assert.equal(r.prompts[0].mode, 'queue')
  assert.equal(r.prompts[0].content[0].text, ASK_PROMPT)
  assert.deepEqual((await r.asker.check()).asked, [])
})

const MIN = 60_000
const logOf = (...records) => ({ records })

test('lastActivityAt: the latest turn, user, assistant or tool record; bookkeeping records and records without a time do not count', () => {
  assert.equal(lastActivityAt([]), 0)
  assert.equal(lastActivityAt(undefined), 0)
  assert.equal(lastActivityAt([
    { type: 'user/message', time: 10 }, { type: 'assistant/message', time: 30 }, { type: 'tool/result', time: 20 }, { type: 'turn/end', time: 40 },
    { type: 'tool/ptc-dispatch', time: 35 }, { type: 'session/title', time: 90 }, { type: 'command/done', time: 95 }, { type: 'turn/end' }, { type: 'turn/end', time: 'late' }, null,
  ]), 40)
})

test('a session whose agent worked long after the last prompt is asked only once it is idle from that activity', async () => {
  // Last prompt 9 hours ago; the turn that followed ended 5 minutes ago.
  const logs = { a: [{ type: 'user/message', time: 1 * H }, { type: 'turn/end', time: 10 * H - 5 * MIN }] }
  const r = rig([S('a', 1 * H)], { readLog: async (id) => logOf(...logs[id]) })
  const first = await r.asker.check()
  assert.deepEqual(first.asked, [])
  assert.deepEqual(first.recent, ['a'])
  assert.equal(r.prompts.length, 0)
  r.setNow(10 * H + 54 * MIN) // 59 minutes after the turn ended
  assert.deepEqual((await r.asker.check()).asked, [])
  r.setNow(10 * H + 56 * MIN) // 61 minutes after
  assert.deepEqual((await r.asker.check()).asked, ['a'])
  assert.deepEqual((await r.asker.check()).asked, [], 'once per idle state')
})

test('laptop sleep after the last activity is not idle time either', async () => {
  let t = 10 * H
  const sleep = createSleepTracker({ now: () => t })
  const activity = 10 * H - 90 * MIN
  t = activity + 10 * MIN; sleep.beat()
  t = activity + 70 * MIN; sleep.beat() // a 60 minute gap: slept
  const r = rig([S('a', 1 * H)], { sleep, readLog: async () => logOf({ type: 'turn/end', time: activity }) })
  r.setNow(10 * H)
  assert.deepEqual((await r.asker.check()).asked, []) // 30 min awake only
  r.setNow(10 * H + 31 * MIN)
  assert.deepEqual((await r.asker.check()).asked, ['a'])
})

test('records that are not activity do not postpone the ask', async () => {
  const r = rig([S('a', 1 * H)], { readLog: async () => logOf({ type: 'session/title', time: 10 * H - MIN }, { type: 'command/done', time: 10 * H - MIN }) })
  assert.deepEqual((await r.asker.check()).asked, ['a'])
})

test('recently active sessions do not use up the per-pass limit of the idle ones', async () => {
  const items = []
  const logs = {}
  for (let i = 0; i < 6; i++) { items.push(S('busy' + i, 1 * H + i)); logs['busy' + i] = [{ type: 'turn/end', time: 10 * H - MIN }] }
  items.push(S('idle', 1 * H)); logs.idle = [{ type: 'turn/end', time: 2 * H }]
  const r = rig(items, { readLog: async (id) => logOf(...logs[id]) })
  const res = await r.asker.check()
  assert.deepEqual(res.asked, ['idle'])
  assert.equal(res.recent.length, 6)
})

test('a pass reads at most maxReadsPerPass logs and asks at most maxPerPass sessions', async () => {
  const items = Array.from({ length: 10 }, (_, i) => S('s' + i, 1 * H + i))
  let reads = 0
  const r = rig(items, { maxReadsPerPass: 4, readLog: async () => { reads++; return logOf() } })
  assert.equal((await r.asker.check()).asked.length, 4)
  assert.equal(reads, 4)
  const r2 = rig(items, { maxPerPass: 2, readLog: async () => logOf() })
  assert.equal((await r2.asker.check()).asked.length, 2)
})

test('a session whose log was written within the idle time is skipped by a stat, without reading its log, and the pass says so', async () => {
  let reads = 0
  const logs = []
  const written = { a: 10 * H - 5 * MIN }
  const r = rig([S('a', 1 * H)], { log: (l) => logs.push(l), lastWriteOf: async (id) => written[id], readLog: async () => { reads++; return logOf() } })
  const first = await r.asker.check()
  assert.deepEqual(first.asked, [])
  assert.deepEqual(first.recent, ['a'])
  assert.equal(reads, 0)
  assert.ok(logs.some((l) => /1 session\(s\) not asked yet/.test(l)), logs.join(' | '))
  r.setNow(10 * H + 56 * MIN)
  assert.deepEqual((await r.asker.check()).asked, ['a'])
  assert.equal(reads, 1)
})

test('sessions skipped by a stat do not use up the read budget of the idle ones', async () => {
  const items = []
  const written = { idle: 2 * H }
  for (let i = 0; i < 25; i++) { items.push(S('recent' + i, 2 * H + i)); written['recent' + i] = 10 * H - MIN }
  items.push(S('idle', 1 * H))
  let reads = 0
  const r = rig(items, { maxReadsPerPass: 2, lastWriteOf: async (id) => written[id], readLog: async () => { reads++; return logOf() } })
  const res = await r.asker.check()
  assert.deepEqual(res.asked, ['idle'])
  assert.equal(res.recent.length, 25)
  assert.equal(reads, 1)
})

test('a session without a write time is judged from its log', async () => {
  const r = rig([S('a', 1 * H)], { lastWriteOf: async () => undefined, readLog: async () => logOf({ type: 'turn/end', time: 10 * H - MIN }) })
  const res = await r.asker.check()
  assert.deepEqual(res.asked, [])
  assert.deepEqual(res.recent, ['a'])
})

test('a log that cannot be read keeps its session from being asked and is logged once per session; a background job is not logged', async () => {
  const logs = []
  const started = { type: 'tool/result', time: 5, data: { content: 'started background job job-1' } }
  const r = rig([S('gone', 1 * H), S('boom', 1 * H), S('job', 1 * H)], {
    log: (l) => logs.push(l),
    readLog: async (id) => { if (id === 'boom') throw new Error('disk on fire'); return id === 'job' ? logOf(started) : undefined },
  })
  assert.deepEqual((await r.asker.check()).skipped.sort(), ['boom', 'gone', 'job'])
  await r.asker.check()
  assert.equal(logs.filter((l) => /not asking gone: .*missing, unreadable or over the size limit/.test(l)).length, 1)
  assert.equal(logs.filter((l) => /not asking boom: .*disk on fire/.test(l)).length, 1)
  assert.equal(logs.filter((l) => /not asking job/.test(l)).length, 0)
})

test('never asks a working session, one with a running child, a blank, an archived or a held one', async () => {
  const old = 1 * H
  const r = rig([S('run', old, { running: true }), S('parent', old), S('child', old + 1, { running: true, parentSessionId: 'parent' }), S('blank', old, { blank: true }), S('arch', old), S('held', old)], {
    registryOf: () => ({ archivedSessionIds: ['arch'] }), heldIds: () => new Set(['held']),
  })
  assert.deepEqual((await r.asker.check()).asked, [])
})

test('does not ask a session with a background job still running, nor one whose log cannot be read', async () => {
  const started = { type: 'tool/result', time: 5, data: { content: 'started background job job-1' } }
  const logs = { busy: [started], done: [started, { type: 'tool/ptc-dispatch', time: 6, data: { name: 'job_kill', arguments: { job_id: 'job-1' } } }], free: [] }
  const r = rig([S('busy', 1 * H), S('done', 1 * H), S('free', 1 * H), S('gone', 1 * H)], {
    readLog: async (id) => (logs[id] ? { records: logs[id] } : undefined),
  })
  const res = await r.asker.check()
  assert.deepEqual(res.asked.sort(), ['done', 'free'])
  assert.deepEqual(res.skipped.sort(), ['busy', 'gone'])
})

test('does not ask a session that already has an open question or permission card', async () => {
  const r = rig([S('a', 1 * H)])
  r.store.add({ type: 'question', sessionId: 'a', questions: [] })
  assert.deepEqual((await r.asker.check()).asked, [])
})

test('laptop sleep time is not idle time', async () => {
  let t = 10 * H
  const sleep = createSleepTracker({ now: () => t })
  const updatedAt = 10 * H - 90 * 60_000 // 90 min ago
  t = updatedAt + 10 * 60_000; sleep.beat()
  t = updatedAt + 70 * 60_000; sleep.beat() // a 60 minute gap: slept
  assert.equal(sleep.sleptBetween(updatedAt, 10 * H), 60 * 60_000)
  const r = rig([S('a', updatedAt)], { sleep })
  r.setNow(10 * H)
  assert.deepEqual((await r.asker.check()).asked, []) // 30 min awake only
  r.setNow(10 * H + 31 * 60_000)
  assert.deepEqual((await r.asker.check()).asked, ['a'])
})

test('a short gap between beats is not sleep', () => {
  let t = 0
  const sleep = createSleepTracker({ now: () => t })
  sleep.beat(); t = 30_000; sleep.beat(); t = 60_000; sleep.beat()
  assert.equal(sleep.sleptBetween(0, 100_000), 0)
})

test('an Archive answer to the asked question archives the session, a Continue answer does not', async () => {
  const r = rig([S('a', 1 * H), S('c', 1 * H)])
  await r.asker.check()
  r.setNow(10 * H + 5000)
  const qa = r.store.add({ type: 'question', sessionId: 'a', questions: [] })
  const qc = r.store.add({ type: 'question', sessionId: 'c', questions: [] })
  r.store.resolve(qa.id ?? qa, { kind: 'answered', by: 'card', answers: [{ id: 'q', selected: ['Archive'] }] })
  r.store.resolve(qc.id ?? qc, { kind: 'answered', by: 'card', answers: [{ id: 'q', selected: ['Continue (Recommended)'] }] })
  assert.deepEqual(await r.asker.archiveAnswered(), ['a'])
  assert.deepEqual(r.archived, [['a', { stopActivity: true }]])
  assert.deepEqual(await r.asker.archiveAnswered(), [])
})

test('the prompt tells a model that wraps the question in run_code to raise that call\'s own timeout and to re-ask once when it still times out', () => {
  for (const needle of ['run_code', 'timeoutMs 600000', 'ask it once more']) assert.ok(ASK_PROMPT.includes(needle), needle)
})

test('the prompt asks with ask_user_question, recommends only for unfinished work, and waits forever otherwise', () => {
  for (const needle of ['ask_user_question', 'Continue', 'Archive', '(Recommended)', 'timeout 600', 'no timeout']) assert.ok(ASK_PROMPT.includes(needle), needle)
})

test('isPrTitle: sessions that name a pull request, and only those', () => {
  for (const title of ['PR 6554', 'PR 6568 - Fix: Widget - 25719', 'Grab 4 tickets - after PR 6578', 'use all-4-1 skill ... - after PR 6602, 66', 'Continue PR 12']) assert.equal(isPrTitle(title), true, title)
  for (const title of ['Fix: Widget - 25719', 'Improve the PRODUCT page', 'spring cleaning', '', undefined]) assert.equal(isPrTitle(title), false, String(title))
})

test('never asks a session titled with a PR (its poller automation is why it is idle), by row title or by the title reader', async () => {
  const old = 1 * H
  const row = (id, title, extra = {}) => S(id, old, { projections: { values: { title } }, ...extra })
  const r = rig([row('pr', 'PR 6554'), row('wait', 'Grab 4 tickets - after PR 6578'), row('plain', 'Fix: Widget - 25719'), S('read', old), S('readplain', old)], {
    titlesOf: async (ids) => new Map(ids.map((id) => [id, id === 'read' ? 'PR 77 - Fix: x' : 'Just work'])),
  })
  assert.deepEqual((await r.asker.check()).asked.sort(), ['plain', 'readplain'])
})

test('PR-titled sessions do not use up the per-pass limit of the others', async () => {
  const items = []
  for (let i = 0; i < 6; i++) items.push(S('pr' + i, 1 * H + i, { projections: { values: { title: 'PR ' + (100 + i) } } }))
  items.push(S('free', 1 * H, { projections: { values: { title: 'free work' } } }))
  const r = rig(items)
  assert.deepEqual((await r.asker.check()).asked, ['free'])
})

test('a failing title reader does not stop the others from being asked', async () => {
  const r = rig([S('a', 1 * H)], { titlesOf: async () => { throw new Error('boom') } })
  assert.deepEqual((await r.asker.check()).asked, ['a'])
})

test('an Archive answer does not archive the poll session of a still-open PR (once per ask, logged)', async () => {
  const logs = []
  const guard = { check: async (id) => (id === 'a' ? { protected: true, prId: '5', status: 'active' } : { protected: false }) }
  const r = rig([S('a', 1 * H), S('c', 1 * H)], { prGuardOf: () => guard, log: (line) => logs.push(line) })
  await r.asker.check()
  r.setNow(10 * H + 5000)
  for (const session of ['a', 'c']) {
    const q = r.store.add({ type: 'question', sessionId: session, questions: [] })
    r.store.resolve(q.id ?? q, { kind: 'answered', by: 'card', answers: [{ id: 'q', selected: ['Archive'] }] })
  }
  assert.deepEqual(await r.asker.archiveAnswered(), ['c'])
  assert.deepEqual(r.archived, [['c', { stopActivity: true }]])
  assert.ok(logs.some((l) => /not archived a: PR 5 is still open/.test(l)))
  assert.deepEqual(await r.asker.archiveAnswered(), [], 'not asked about again')
  assert.equal(r.archived.length, 1)
})

test('an Archive answer for a session that is handing over a just-created PR is not archived and the log says hand-over', async () => {
  const logs = []
  const guard = { check: async () => ({ protected: true, prId: '7', status: 'handover' }) }
  const r = rig([S('a', 1 * H)], { prGuardOf: () => guard, log: (line) => logs.push(line) })
  await r.asker.check()
  r.setNow(10 * H + 5000)
  const q = r.store.add({ type: 'question', sessionId: 'a', questions: [] })
  r.store.resolve(q.id ?? q, { kind: 'answered', by: 'card', answers: [{ id: 'q', selected: ['Archive'] }] })
  assert.deepEqual(await r.asker.archiveAnswered(), [])
  assert.equal(r.archived.length, 0)
  assert.ok(logs.some((l) => /not archived a: .*hand(ing)?[- ]?over.*PR 7/i.test(l)), logs.join(' | '))
  assert.ok(!logs.some((l) => /still open/.test(l)), 'no "still open" wording for a hand-over')
})

test('a guard that throws does not stop a requested archive from being handled', async () => {
  const r = rig([S('a', 1 * H)], { prGuardOf: () => ({ check: async () => { throw new Error('guard broke') } }) })
  await r.asker.check()
  r.setNow(10 * H + 5000)
  const q = r.store.add({ type: 'question', sessionId: 'a', questions: [] })
  r.store.resolve(q.id ?? q, { kind: 'answered', by: 'card', answers: [{ id: 'q', selected: ['Archive'] }] })
  assert.deepEqual(await r.asker.archiveAnswered(), ['a'])
})
