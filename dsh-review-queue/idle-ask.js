/**
 * Idle-session ask: every check (default 10 minutes) looks at the sessions that are NOT working and have been idle for more than an hour of
 * awake time, and asks the user, inside that session, whether to continue it or archive it.
 *   - Idle means: top-level, no turn running, no child session (agent) running, no background job left (when readLog is given; a log that cannot be read
 *     counts as busy), not blank, not archived, not on hold, no open question or permission card.
 *   - Idle time runs from the later of the session's last prompt (its row's updatedAt) and the last activity in its log (a turn, message, tool call or
 *     tool result): a session whose agent worked for hours after the last prompt is not idle the moment that turn ends. Without readLog only the
 *     last prompt is known.
 *   - Awake time: the time the laptop slept is not counted. A heartbeat (every BEAT_MS) that finds a gap longer than SLEEP_GAP_MS records the gap as sleep.
 *   - The session is prompted (queued) with ASK_PROMPT: it asks with ask_user_question. Continue marked recommended (only when its work is unfinished) is
 *     asked with a timeout, so the existing auto-answer takes the recommended option; no recommended option means no timeout: the question waits forever.
 *   - A session whose title names a pull request ("PR 6554", "... - after PR 6554") is never asked: its poller automation tasks (comment poll, approval wait) are the
 *     reason it is idle, and the PR poller archives it itself once the PR is merged or abandoned.
 *   - An answered question that contains "archive" archives the session (registry.archiveSession), unless it polls a PR that is still open (the guard answers); "continue" needs nothing, the session carries on itself.
 * Every idle state (session id + updatedAt) is asked once; the asks are saved through io, so a restart asks nothing twice.
 */
import { randomUUID } from 'node:crypto'
import { isTopLevel } from './userpause.js'
import { liveBackgroundJobs } from './idle-resume.js'

export const ASK_IDLE_MS = 60 * 60_000
export const ASK_CHECK_MS = 10 * 60_000
export const BEAT_MS = 30_000
/** A heartbeat gap longer than this means the machine slept (or the process was frozen). */
export const SLEEP_GAP_MS = 2 * 60_000
export const MAX_AGE_MS = 3 * 24 * 3600_000
export const MAX_PER_PASS = 5
/** Logs read in one pass at most. A session skipped as busy or unreadable also costs a read, one whose log was written recently does not (a stat settles it). */
export const MAX_READS_PER_PASS = 4 * MAX_PER_PASS
/** Log records that show the session itself or its user at work, bookkeeping records (titles, commands, projections) do not. */
const ACTIVITY_TYPE = /^(?:turn|user|assistant|tool)\//
const RETENTION_MS = 7 * 24 * 3600_000
const LIST_TIMEOUT_MS = 10_000
const PROMPT_TIMEOUT_MS = 15_000
const NOT_FOUND = 'session/not-found'

export const ASK_PROMPT = 'This session has been idle for more than an hour. Call ask_user_question once and ask me whether to continue this session or archive it, with the options '
  + '"Continue" and "Archive". Put "Continue" first and add "(Recommended)" to its label ONLY if your work here is unfinished and needs nobody\'s answer; in that case pass timeout 600. '
  + 'If the work is finished or you are waiting for me, recommend nothing and pass no timeout, so the question waits for me. '
  + 'If you call it from inside run_code, give that run_code call timeoutMs 600000, because its default deadline of 2 minutes would kill the question; if the run still times out, ask it once more. '
  + 'If I pick Continue, check git status and the last tool calls and carry on with the task; start nothing new. If I pick Archive, reply with one line that the session is being archived and stop.'

/**
 * The time of the last activity in a session log.
 * @param {object[]} records the log records
 * @returns {number} the latest `time` of a turn, user, assistant or tool record (0 when there is none)
 */
export function lastActivityAt(records) {
  let latest = 0
  for (const r of Array.isArray(records) ? records : []) {
    if (typeof r?.type === 'string' && ACTIVITY_TYPE.test(r.type) && Number.isFinite(r.time) && r.time > latest) latest = r.time
  }
  return latest
}

/** Tracks the time the machine slept: beat() is called often; a long gap between two beats is a sleep. */
export function createSleepTracker({ now = Date.now, gapMs = SLEEP_GAP_MS, io } = {}) {
  let intervals = []
  let last
  try { const d = JSON.parse(io?.read?.() ?? 'null'); if (d?.v === 1 && Array.isArray(d.intervals)) intervals = d.intervals.filter((i) => Number.isFinite(i?.from) && Number.isFinite(i?.to) && i.to > i.from) } catch { intervals = [] }
  const save = () => { try { io?.write?.(JSON.stringify({ v: 1, intervals })) } catch { /* memory only */ } }
  return {
    beat() {
      const t = now()
      if (last !== undefined && t - last > gapMs) {
        intervals.push({ from: last, to: t })
        intervals = intervals.filter((i) => t - i.to < RETENTION_MS)
        save()
      }
      last = t
    },
    /** Milliseconds of recorded sleep inside [from, to]. */
    sleptBetween(from, to) {
      let total = 0
      for (const i of intervals) total += Math.max(0, Math.min(to, i.to) - Math.max(from, i.from))
      return total
    },
  }
}

/** A session title that names a pull request: "PR 6554", "PR 6554 - Fix: ...", "... - after PR 6554". Such a session belongs to the PR poller. */
export const isPrTitle = (title) => /\bPR\s*#?\d+/i.test(String(title ?? ''))
const rowTitleOf = (item) => { const v = item?.projections?.values?.title; return typeof v === 'string' ? v : (typeof item?.title === 'string' ? item.title : '') }

const archiveWanted = (item) => (item?.resolution?.answers ?? []).some((a) => [...(Array.isArray(a?.selected) ? a.selected : []), a?.custom].some((s) => typeof s === 'string' && /archive/i.test(s)))

export function createIdleAsker({ controllerOf, registryOf = () => undefined, prGuardOf = () => undefined, store, sleep, heldIds = () => new Set(), now = Date.now, idleMs = ASK_IDLE_MS, maxAgeMs = MAX_AGE_MS,
  maxPerPass = MAX_PER_PASS, maxReadsPerPass = MAX_READS_PER_PASS, io, log = () => {}, readLog, lastWriteOf, startedAt = 0, titlesOf }) {
  let state = {} // sessionId -> { updatedAt, at, archived? }
  try {
    const d = JSON.parse(io?.read?.() ?? 'null')
    if (d?.v === 1 && d.items && typeof d.items === 'object') for (const [id, r] of Object.entries(d.items)) if (Number.isFinite(r?.updatedAt) && Number.isFinite(r?.at)) state[id] = { updatedAt: r.updatedAt, at: r.at, archived: r.archived === true }
  } catch { state = {} }
  const save = () => {
    for (const [id, r] of Object.entries(state)) if (now() - r.at > RETENTION_MS) delete state[id]
    try { io?.write?.(JSON.stringify({ v: 1, items: state })) } catch { /* memory only */ }
  }
  const reasonOf = (e) => String(e?.message ?? e).replace(/\s+/g, ' ').slice(0, 200)
  const waiting = (id) => (store?.list?.({ status: 'open' }) ?? []).some((i) => i.sessionId === id && (i.type === 'question' || i.type === 'permission'))

  /** Awake idle time of a session: wall time since `since` (its last prompt or last activity) minus the machine's sleep. */
  const awakeIdle = (since) => now() - since - (sleep?.sleptBetween(since, now()) ?? 0)

  // One read of the session log gives both answers. A background job (run_in_background, not collected or killed since the app started) is work still
  // running: no ask. A log that cannot be read is treated as busy and says why. activityAt is when the log last shows the session or its user at work.
  async function inspectLog(sessionId) {
    try {
      const log1 = await readLog(sessionId)
      if (!log1) return { busy: true, activityAt: 0, unreadable: 'missing, unreadable or over the size limit' }
      return { busy: liveBackgroundJobs(log1.records, { startedAt }).length > 0, activityAt: lastActivityAt(log1.records) }
    } catch (error) { return { busy: true, activityAt: 0, unreadable: reasonOf(error) } }
  }

  // An unreadable log keeps its session from ever being asked: say so once per session instead of on every pass.
  const reportedUnreadable = new Set()
  function reportUnreadable(sessionId, why) {
    if (reportedUnreadable.has(sessionId)) return
    reportedUnreadable.add(sessionId)
    log('idle-ask: not asking ' + sessionId + ': its log cannot be read (' + why + ')')
  }

  /** The sessions whose title does not name a pull request. A row without a title of its own is looked up by titlesOf; a failing lookup keeps the session (it is asked). */
  async function withoutPrSessions(list) {
    const own = new Map(list.map((i) => [i.sessionId, rowTitleOf(i)]))
    const missing = list.map((i) => i.sessionId).filter((id) => !own.get(id))
    let read = new Map()
    if (missing.length && typeof titlesOf === 'function') { try { const got = await titlesOf(missing); if (got instanceof Map) read = got } catch (error) { log('idle-ask: titles unavailable: ' + reasonOf(error)) } }
    return list.filter((i) => !isPrTitle(own.get(i.sessionId) || read.get(i.sessionId)))
  }

  async function run() {
    const controller = controllerOf()
    if (typeof controller?.list !== 'function' || typeof controller?.prompt !== 'function') return { ok: false, error: 'no-controller' }
    let items
    try { items = (await controller.list({}, AbortSignal.timeout(LIST_TIMEOUT_MS)))?.items } catch (error) { log('idle-ask: listing the sessions failed: ' + reasonOf(error)); return { ok: false, error: 'list-failed' } }
    if (!Array.isArray(items)) return { ok: false, error: 'list-failed' }
    const archived = new Set((() => { try { return registryOf()?.archivedSessionIds ?? [] } catch { return [] } })().map(String))
    const busyParents = new Set(items.filter((i) => i?.running === true && i.parentSessionId).map((i) => String(i.parentSessionId)))
    const held = heldIds()
    const t = now()
    const idle = items
      .filter((i) => i && typeof i.sessionId === 'string' && isTopLevel(i) && i.running !== true && i.blank !== true && !archived.has(i.sessionId) && !held.has(i.sessionId) && !busyParents.has(i.sessionId)
        && Number.isFinite(i.updatedAt) && t - i.updatedAt <= maxAgeMs && awakeIdle(i.updatedAt) >= idleMs && state[i.sessionId]?.updatedAt !== i.updatedAt && !waiting(i.sessionId))
      .sort((a, b) => b.updatedAt - a.updatedAt)
    const candidates = await withoutPrSessions(idle)
    const result = { ok: true, asked: [], skipped: [], recent: [] }
    let reads = 0
    for (const item of candidates) {
      if (result.asked.length >= maxPerPass) break
      // A log written within the idle time cannot belong to an idle session. A stat settles that without reading it, and costs no read.
      const written = lastWriteOf ? await lastWriteOf(item.sessionId) : undefined
      if (written !== undefined && awakeIdle(Math.max(item.updatedAt, written)) < idleMs) { result.recent.push(item.sessionId); continue }
      let since = item.updatedAt
      if (readLog) {
        if (reads >= maxReadsPerPass) break
        reads++
        const seen = await inspectLog(item.sessionId)
        if (seen.unreadable) reportUnreadable(item.sessionId, seen.unreadable)
        if (seen.busy) { result.skipped.push(item.sessionId); continue }
        since = Math.max(since, seen.activityAt)
        if (awakeIdle(since) < idleMs) { result.recent.push(item.sessionId); continue }
      }
      try {
        await controller.prompt({ requestId: 'idle-ask-' + randomUUID(), sessionId: item.sessionId, mode: 'queue', content: [{ type: 'text', text: ASK_PROMPT }] }, AbortSignal.timeout(PROMPT_TIMEOUT_MS))
      } catch (error) {
        if (error?.code === NOT_FOUND) { state[item.sessionId] = { updatedAt: item.updatedAt, at: now() }; save() }
        log('idle-ask: asking ' + item.sessionId + ' failed: ' + reasonOf(error))
        continue
      }
      state[item.sessionId] = { updatedAt: item.updatedAt, at: now() }
      save()
      result.asked.push(item.sessionId)
      log('idle-ask: asked ' + item.sessionId + ' (idle ' + Math.round(awakeIdle(since) / 60_000) + ' min awake)')
    }
    if (result.recent.length) log('idle-ask: ' + result.recent.length + ' session(s) not asked yet: active since their last prompt')
    return result
  }

  /** The guard's verdict when the session polls a PR that is still open (dsh-hooks-tts's prArchiveGuard; without that plugin, or when it throws, undefined). */
  const prOpenOf = async (sessionId) => { try { const v = await prGuardOf()?.check(sessionId); return v?.protected ? v : undefined } catch { return undefined } }

  /** Archives the asked sessions whose question the user answered with Archive (once per ask). */
  async function archiveAnswered() {
    const done = []
    for (const item of store?.list?.({}) ?? []) {
      const rec = state[item.sessionId]
      if (!rec || rec.archived || item.type !== 'question' || item.status === 'open' || item.createdAt < rec.at || !archiveWanted(item)) continue
      const registry = registryOf()
      if (typeof registry?.archiveSession !== 'function') continue
      rec.archived = true
      save()
      const open = await prOpenOf(item.sessionId)
      if (open) { log('idle-ask: not archived ' + item.sessionId + ': ' + (open.status === 'handover' ? 'hand-over of PR ' + open.prId + ' is in progress' : 'PR ' + open.prId + ' is still open')); continue }
      try { await registry.archiveSession(item.sessionId, { stopActivity: true }); done.push(item.sessionId); log('idle-ask: archived ' + item.sessionId + ' on your answer') } catch (error) { log('idle-ask: archiving ' + item.sessionId + ' failed: ' + reasonOf(error)) }
    }
    return done
  }

  let running
  return {
    /** One pass: { ok: true, asked, skipped (busy or unreadable log), recent (active since their last prompt) } with session ids | { ok: false, error }. Passes never overlap. */
    check() {
      running ??= run().then(async (r) => { await archiveAnswered(); return r }).catch((error) => { log('idle-ask: check failed: ' + reasonOf(error)); return { ok: false, error: 'check-failed' } }).finally(() => { running = undefined })
      return running
    },
    archiveAnswered,
  }
}
