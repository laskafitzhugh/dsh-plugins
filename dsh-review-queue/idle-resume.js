/**
 * Idle-session resume: the periodic check of sessions that were idle for a long time (default 30 minutes) and may have stopped before their
 * work was done. Idle means: no turn is running, no subagent (child session) is running and no background process (a job started with
 * run_in_background and not collected, killed or finished since the app started) is left. Such a session is looked at (its log and, when it is not
 * plainly cut off, a cheap model) and then
 *   - resumed WITHOUT asking the user, when it was cut off in a turn or the model says the work is unfinished and needs nobody's answer;
 *   - left alone, when it is finished or waits for the user (the model says done);
 *   - put to the user as a card (the unsure hook), when the model is not sure, or the session was already resumed 3 times in 24 hours.
 * Every idle state (a session id and its updatedAt) is decided once; the decisions are saved through io, so a restart asks nothing twice.
 */
import { randomUUID } from 'node:crypto'
import { stat, readFile } from 'node:fs/promises'
import { RESUME_PROMPT, classifyLog, parseLog } from './paused.js'
import { createModelRun, NOTE_NO_MODEL, NOTE_UNUSABLE } from './summary.js'
import { findSessionLog } from './thread.js'
import { isTopLevel } from './userpause.js'

export const IDLE_MS = 30 * 60_000
/** The check runs this often. */
export const CHECK_MS = 10 * 60_000
/** Sessions idle for longer than this are not looked at any more. */
export const MAX_AGE_MS = 3 * 24 * 3600_000
export const MAX_PER_PASS = 5
/** A session is resumed this many times in RESUME_WINDOW_MS at most; then the user is asked. */
export const MAX_AUTO_RESUMES = 3
const RESUME_WINDOW_MS = 24 * 3600_000
const STATE_RETENTION_MS = 7 * 24 * 3600_000
const MAX_LOG_BYTES = 16 * 1024 * 1024
const LIST_TIMEOUT_MS = 10_000
const LIST_ATTEMPTS = 2
const PROMPT_TIMEOUT_MS = 15_000
const MAX_REASON = 300
const MAX_USER_CHARS = 600
const MAX_ASSISTANT_CHARS = 1500
const NOT_FOUND = 'session/not-found'

/** What a session that stopped quietly is told: look at the real state, finish, or say why it stopped; nothing new. */
export const IDLE_RESUME_PROMPT = 'This session has been idle for a while and may have stopped before its work was finished. First check git status and git log in its worktree '
  + 'and the last tool calls, then continue the task you were doing until it is finished. If it is in fact finished, or you are waiting for an answer from me, say so in one line and stop. '
  + 'Do not start anything new.'

const clip = (s, n) => (s.length > n ? s.slice(0, n) + '…' : s)
const textOf = (content) => (Array.isArray(content) ? content : typeof content === 'string' ? [{ type: 'text', text: content }] : [])
  .filter((c) => c?.type === 'text' && typeof c.text === 'string').map((c) => c.text).join('\n').trim()
const argsOf = (data) => {
  const a = data?.arguments
  if (a && typeof a === 'object') return a
  try { const p = JSON.parse(a); return p && typeof p === 'object' ? p : {} } catch { return {} }
}

// ---- background processes -----------------------------------------------------------------------------------------------------------------

const JOB_STARTED = /started background job (\S+)/i
const JOB_DONE = /status\W+(?:completed|exited|killed|failed|finished|stopped)/i

/**
 * The background jobs of a session that may still run: started (a result "started background job <id>") after the app started (a restart ends every
 * process) and not killed, not collected with a finished status and not gone from a later empty job list.
 * @param {object[]} records the log records
 * @returns {string[]} the job ids
 */
export function liveBackgroundJobs(records, { startedAt = 0 } = {}) {
  const jobs = new Map() // id -> time it started
  const watching = new Map() // callId of a direct job_output call -> job id
  for (const r of Array.isArray(records) ? records : []) {
    const d = r?.data ?? {}
    const time = Number.isFinite(r?.time) ? r.time : 0
    const out = textOf(d.content) + '\n' + textOf(d.message?.content)
    if (r?.type === 'tool/ptc-dispatch' || r?.type === 'tool/call') {
      const args = argsOf(d)
      if (d.name === 'job_kill' && typeof args.job_id === 'string') jobs.delete(args.job_id)
      else if (d.name === 'job_output' && typeof args.job_id === 'string') {
        if (r.type === 'tool/call') { if (d.callId) watching.set(d.callId, args.job_id) } else if (JOB_DONE.test(out)) jobs.delete(args.job_id)
      }
    }
    if (r?.type === 'tool/result') {
      const watched = watching.get(d.message?.source?.callId)
      if (watched && JOB_DONE.test(out)) jobs.delete(watched)
    }
    if (r?.type === 'tool/ptc-dispatch' || r?.type === 'tool/result') {
      const started = JOB_STARTED.exec(out)
      if (started) jobs.set(started[1], time)
      if (/\(no background jobs\)/i.test(out)) jobs.clear()
    }
  }
  return [...jobs].filter(([, time]) => time >= startedAt).map(([id]) => id)
}

// ---- reading a log --------------------------------------------------------------------------------------------------------------------

/** readLog(sessionId) -> { records, torn } | undefined: the log of a session under the sessions folder (undefined when missing, unreadable or over maxBytes). */
export function createLogReader({ root, maxBytes = MAX_LOG_BYTES, io = {} } = {}) {
  const fs = { stat, readFile, ...io }
  return async (sessionId) => {
    try {
      const file = await findSessionLog(root, sessionId)
      if (!file) return undefined
      if ((await fs.stat(file)).size > maxBytes) return undefined
      const { records, torn } = parseLog(await fs.readFile(file))
      return { records, torn }
    } catch { return undefined }
  }
}

/** lastWriteOf(sessionId) -> the time (ms) of the last write to the session log, or undefined when there is none: a stat, the log is not read. */
export function createLogStatter({ root, io = {} } = {}) {
  const fs = { stat, ...io }
  return async (sessionId) => {
    try {
      const file = await findSessionLog(root, sessionId)
      return file ? Math.round((await fs.stat(file)).mtimeMs) : undefined
    } catch { return undefined }
  }
}

/** The last user request and the last assistant reply of a log, longer than classifyLog keeps them (the model needs the end of the reply). */
function lastTexts(records) {
  let lastUser = ''
  let lastAssistant = ''
  for (const r of records) {
    const d = r?.data ?? {}
    if (r?.type === 'user/message' && (d.source?.kind === undefined || d.source?.kind === 'user')) lastUser = textOf(d.content) || lastUser
    else if (r?.type === 'assistant/message') lastAssistant = textOf(d.message?.content) || lastAssistant
  }
  return { lastUser: clip(lastUser, MAX_USER_CHARS), lastAssistant: lastAssistant.length > MAX_ASSISTANT_CHARS ? '…' + lastAssistant.slice(-MAX_ASSISTANT_CHARS) : lastAssistant }
}

// ---- the model judge ------------------------------------------------------------------------------------------------------------------

const VERDICTS = new Set(['resume', 'done', 'unsure'])
const JUDGE_SYSTEM = 'You judge whether a coding-agent session that has been idle for a while needs to be resumed. You get its title, folder, how its last turn ended, the last request of the user and the '
  + 'last reply of the agent. Answer with one JSON object and nothing else: {"verdict":"resume"|"done"|"unsure","reason":"<one short sentence>"}.\n'
  + 'resume: the agent stopped in the middle of the task: it said what it would do next, listed steps that are left, hit an error, a timeout or a limit, or ended with work in progress, '
  + 'and nothing in the reply needs a decision or an answer from the user.\n'
  + 'done: the work is finished, the agent only reported a result, or the reply is waiting for an answer or a decision of the user (a question, options to choose from, an approval, a request to review).\n'
  + 'unsure: you cannot tell from this. When in doubt between resume and unsure, say unsure; when in doubt between done and resume, say done.'

/**
 * The model judge: judge(case) -> { verdict: 'resume' | 'done' | 'unsure', reason? } | { note } (the model could not be asked or answered something unusable). Never throws.
 * The provider's own message (it can carry endpoints or key fragments) stays in the log.
 */
export function createIdleJudge({ llm, timeoutMs = 30_000, maxTokens = 300, log = () => {} } = {}) {
  const run = createModelRun({ llm, timeoutMs })
  return async (c) => {
    const result = await run(async ({ model, signal, trace }) => {
      const prepared = await llm.prepareCall({ provider: model.provider, model: model.model, maxTokens }, signal)
      const body = 'Session title: ' + (c.title || '(none)') + '\nFolder: ' + (c.cwd || '(unknown)') + '\nHow the last turn ended: ' + (c.endKind || 'unknown')
        + (c.danglingCalls?.length ? '\nTool calls without a result: ' + c.danglingCalls.join(', ') : '')
        + '\n\nLast request of the user:\n' + (c.lastUser || '(none)') + '\n\nLast reply of the agent:\n' + (c.lastAssistant || '(none)')
      for await (const chunk of prepared.stream({ ...prepared.config, system: JUDGE_SYSTEM, signal, messages: [{ role: 'user', content: [{ type: 'text', text: body }] }] })) {
        if (chunk.type === 'text-delta') trace.raw += chunk.text
      }
      const from = trace.raw.indexOf('{')
      const to = trace.raw.lastIndexOf('}')
      let parsed
      try { parsed = from >= 0 && to > from ? JSON.parse(trace.raw.slice(from, to + 1)) : undefined } catch { parsed = undefined }
      if (!parsed || typeof parsed !== 'object' || !VERDICTS.has(parsed.verdict)) return { note: NOTE_UNUSABLE }
      const reason = typeof parsed.reason === 'string' ? parsed.reason.replace(/\s+/g, ' ').trim().slice(0, MAX_REASON) : ''
      return { verdict: parsed.verdict, ...(reason ? { reason } : {}) }
    })
    if (result.note?.startsWith('LLM error')) { log('idle-resume: judge failed: ' + result.note); return { note: 'LLM error' } }
    const { raw: _raw, ...answer } = result
    return answer
  }
}

// ---- the check ------------------------------------------------------------------------------------------------------------------------

/**
 * @param {{ controllerOf: () => any, registryOf?: () => any, readLog: (id: string) => Promise<{ records: object[], torn?: boolean } | undefined>,
 *   judge: (c: object) => Promise<object>, unsure?: (c: object) => void, resumed?: (c: object) => void, now?: () => number, startedAt?: number,
 *   idleMs?: number, maxAgeMs?: number, maxPerPass?: number, io?: { read: () => string | undefined, write: (text: string) => void }, log?: (line: string) => void }} deps
 */
export function createIdleResumer({ controllerOf, registryOf = () => undefined, readLog, judge, unsure = () => {}, resumed = () => {}, now = Date.now, startedAt = 0,
  idleMs = IDLE_MS, maxAgeMs = MAX_AGE_MS, maxPerPass = MAX_PER_PASS, io, heldIds = () => new Set(), log = () => {} }) {
  let state = {} // sessionId -> { updatedAt, at, resumes: [ms] }
  try {
    const data = JSON.parse(io?.read?.() ?? 'null')
    if (data?.v === 1 && data.items && typeof data.items === 'object') {
      for (const [id, rec] of Object.entries(data.items)) {
        if (Number.isFinite(rec?.updatedAt) && Number.isFinite(rec?.at)) state[id] = { updatedAt: rec.updatedAt, at: rec.at, resumes: (Array.isArray(rec.resumes) ? rec.resumes : []).filter(Number.isFinite) }
      }
    }
  } catch { state = {} }
  const save = () => {
    for (const [id, rec] of Object.entries(state)) if (now() - rec.at > STATE_RETENTION_MS) delete state[id]
    try { io?.write?.(JSON.stringify({ v: 1, items: state })) } catch { /* kept in memory for this run */ }
  }
  const handle = (id, updatedAt, resumedNow) => {
    const old = state[id]
    const resumes = (old?.resumes ?? []).filter((t) => now() - t < RESUME_WINDOW_MS)
    if (resumedNow) resumes.push(now())
    state[id] = { updatedAt, at: now(), resumes }
    save()
  }
  const isHandled = (item) => state[item.sessionId]?.updatedAt === item.updatedAt
  const reasonOf = (e) => String(e?.message ?? e).replace(/\s+/g, ' ').slice(0, 200)

  async function sendResume(c, text) {
    const controller = controllerOf()
    try {
      await controller.prompt({ requestId: 'idle-resume-' + randomUUID(), sessionId: c.sessionId, mode: 'queue', content: [{ type: 'text', text }] }, AbortSignal.timeout(PROMPT_TIMEOUT_MS))
      return 'sent'
    } catch (error) {
      if (error?.code === NOT_FOUND) { log('idle-resume: ' + c.sessionId + ' is gone (DSH no longer has it)'); return 'gone' }
      log('idle-resume: resuming ' + c.sessionId + ' failed: ' + reasonOf(error))
      return 'failed'
    }
  }

  async function run() {
    const controller = controllerOf()
    if (typeof controller?.list !== 'function' || typeof controller?.prompt !== 'function') return { ok: false, error: 'no-controller' }
    let items
    // The hub's list can be slow while it reads every app's sessions: a failed list is asked once more at once, only a second failure is reported.
    for (let attempt = 1; items === undefined; attempt++) {
      try { items = (await controller.list({}, AbortSignal.timeout(LIST_TIMEOUT_MS)))?.items ?? null } catch (error) {
        if (attempt < LIST_ATTEMPTS) continue
        log('idle-resume: listing the sessions failed: ' + reasonOf(error))
        return { ok: false, error: 'list-failed' }
      }
    }
    if (!Array.isArray(items)) return { ok: false, error: 'list-failed' }
    const archived = new Set((() => { try { return registryOf()?.archivedSessionIds ?? [] } catch { return [] } })().map(String))
    const busyParents = new Set(items.filter((i) => i?.running === true && i.parentSessionId).map((i) => String(i.parentSessionId)))
    const t = now()
    const held = heldIds() // a session on hold is parked on purpose: never resumed by the idle check
    const candidates = items
      .filter((i) => i && typeof i.sessionId === 'string' && !held.has(i.sessionId) && isTopLevel(i) && i.running !== true && i.blank !== true && !archived.has(i.sessionId) && !busyParents.has(i.sessionId)
        && Number.isFinite(i.updatedAt) && t - i.updatedAt >= idleMs && t - i.updatedAt <= maxAgeMs && !isHandled(i))
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .slice(0, maxPerPass)
    const result = { ok: true, checked: 0, resumed: [], asked: [], skipped: { background: 0, unreadable: 0, noModel: 0 } }
    for (const item of candidates) {
      const log1 = await readLog(item.sessionId)
      if (!log1) { result.skipped.unreadable++; continue }
      result.checked++
      if (liveBackgroundJobs(log1.records, { startedAt }).length) { result.skipped.background++; continue }
      const classified = classifyLog(log1.records, { torn: log1.torn })
      const texts = lastTexts(log1.records)
      const c = { sessionId: item.sessionId, title: classified.title ?? '', cwd: classified.head?.cwd ?? item.cwd ?? '', lastWrite: item.updatedAt, endKind: classified.endKind,
        danglingCalls: classified.danglingCalls, ...texts }
      const cutOff = classified.kinds.some((k) => k !== 'torn' && k !== 'limit')
      let verdict
      if (cutOff) verdict = { verdict: 'resume', reason: 'it was cut off in the middle of a turn' }
      else {
        let answer
        try { answer = await judge(c) } catch (error) { log('idle-resume: judge failed: ' + reasonOf(error)); answer = { note: 'LLM error' } }
        if (!answer?.verdict) {
          if (answer?.note === NOTE_UNUSABLE) { log('idle-resume: ' + c.sessionId + ': the model answered something unusable'); handle(item.sessionId, item.updatedAt, false) } else result.skipped.noModel++
          continue
        }
        verdict = answer
      }
      if (verdict.verdict === 'done') { handle(item.sessionId, item.updatedAt, false); continue }
      const recent = (state[item.sessionId]?.resumes ?? []).filter((x) => t - x < RESUME_WINDOW_MS).length
      if (verdict.verdict === 'resume' && recent >= MAX_AUTO_RESUMES) verdict = { verdict: 'unsure', reason: 'It was already resumed ' + MAX_AUTO_RESUMES + ' times in the last 24 hours and stopped again.' }
      if (verdict.verdict === 'unsure') {
        handle(item.sessionId, item.updatedAt, false)
        const ask = { ...c, reason: verdict.reason ?? '' }
        result.asked.push(ask)
        try { unsure(ask) } catch (error) { log('idle-resume: the unsure hook failed: ' + reasonOf(error)) }
        continue
      }
      const sent = await sendResume(c, cutOff ? RESUME_PROMPT : IDLE_RESUME_PROMPT)
      if (sent === 'failed') continue
      handle(item.sessionId, item.updatedAt, sent === 'sent')
      if (sent === 'gone') continue
      const done = { ...c, reason: verdict.reason ?? '' }
      result.resumed.push(done)
      log('idle-resume: resumed ' + c.sessionId + (verdict.reason ? ' (' + verdict.reason + ')' : ''))
      try { resumed(done) } catch (error) { log('idle-resume: the resumed hook failed: ' + reasonOf(error)) }
    }
    return result
  }

  let running
  return {
    /** One pass over the sessions: { ok: true, checked, resumed, asked, skipped } | { ok: false, error }. Passes never overlap: a caller during a pass gets that pass. */
    check() {
      running ??= run().catch((error) => { log('idle-resume: check failed: ' + reasonOf(error)); return { ok: false, error: 'check-failed' } }).finally(() => { running = undefined })
      return running
    },
  }
}
