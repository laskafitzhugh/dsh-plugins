/**
 * dsh-review-queue — host half. Collects what is waiting on the user across every session (finished work, open
 * questions, permission requests) into one queue and serves it to the browser half (lib/client.js: a sidebar tab and
 * a full-screen overlay) under /review-queue on the Host web server.
 *
 * The hub (docs/hub.md): by default each app is an agent of one shared hub process (agent/wire.js) so every app and the phone see
 * one list; `hub: false` or env DSH_RQ_HUB=0 keeps the plugin standalone exactly as it was. Config: `hubPort` (env DSH_RQ_HUB_PORT, default
 * 47615), `hubNode` (the node executable that runs the hub), `instanceLabel` (how this app is named, default "DSH :<port>").
 *
 * Paused sessions (paused.js): at startup and again after the quiet time the plugin scans ~/.dsh/sessions for sessions a restart cut off and lists
 * them (type 'paused'); `paused: false` or env DSH_RQ_PAUSED=0 turns it off, and it is off in node --test runs unless `pausedScan` (a replacement
 * for the scan, called with { root, startedAt, liveIds, skipIds }) is given. `pausedStartMs` (default 5000) and `pausedRescanMs`
 * (default the quiet time plus 15 s, 0 = never) time the two scans.
 *
 * Idle sessions (idle-resume.js): every `idleCheckMs` (default 10 minutes, 0 = once; first check after `idleStartMs`, default 60 s) the plugin looks at the sessions that were idle for
 * `idleMinutes` (default 30): no turn, no subagent and no background process. One that stopped before its work was done is resumed without asking; when the model is not sure the user
 * gets a paused card. `idleResume: false` or env DSH_RQ_IDLE_RESUME=0 turns it off, and it is off in node --test runs unless `idleResume: true`; `idleDeps` ({ readLog, judge }) replaces the
 * log reader and the model judge (tests).
 *
 * Hourly AI report (ai-reporter.js): on by default; `aiReport: false` or env DSH_RQ_AI_REPORT=0 turns it off, and it is off in node --test runs unless `aiReport: true`. `aiReport` may be an object { intervalMinutes (60), voice, chat (false = channel off), rcEnvFile }; `aiReportDeps` ({ notify, speaker, now, spawn }) replaces parts (tests).
 *
 * `taskbarBadge` (default on, Windows only; env DSH_RQ_TASKBAR=0 turns it off): the number of waiting items as a badge on the app's taskbar button (taskbar.js).
 *
 * Config (all optional): `sparcCommandPath` (the modes:sparc command file a "Use SPARC" todo inlines, default ~/.claude/commands/modes/sparc.md), `stateDir` (where queue.json lives), `ttsClient` (path of dsh-hooks-tts's tts-client.ps1, default the
 * sibling plugin folder), `voice` ('male' default, or 'female') for the play button, `dev` (true, or env DSH_REVIEW_QUEUE_DEV=1, enables the
 * /v1/dev/ask route that creates fake questions, permissions and completions for testing the UI), `pushSubject` (the mailto: or https: contact
 * the push services see in the VAPID token) and `sendPush` (replaces the real Web Push delivery, for tests).
 */
import { randomBytes } from 'node:crypto'
import { spawn } from 'node:child_process'
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { awaitPort, hubEnabled, instanceKeyOf, instanceLabelOf } from './agent/config.js'
import { hubPortOf } from './agent/launcher.js'
import { createStoreAdapter } from './agent/store-adapter.js'
import { wireHub } from './agent/wire.js'
import { createStore } from './store.js'
import { createAutoClear } from './auto-clear.js'
import { createSummarizer } from './summary.js'
import { createTitleReader } from './titles.js'
import { createTuner } from './todo-tune.js'
import { createTodoImages } from './todo-images.js'
import { createTipper, recentTopics } from './tip.js'
import { createExpander } from './tip-expand.js'
import { createSessionCounter } from './sessions.js'
import { installCapture, cancelStalePending } from './capture.js'
import { installTicketSessions } from './ticket-session.js'
import { createOnHold } from './onhold.js'
import { installOnHoldCommand } from './onhold-command.js'
import { installArchiveOffer } from './archive-offer.js'
import { fetchTicketState } from './ado-ticket.js'
import { adoBaseOf, createTask } from './ado-create.js'
import { createReviewQueue } from './service.js'
import { createReader } from './reader.js'
import { listWorkspaces } from './todo.js'
import { createRouter, PREFIX } from './server.js'
import { createPushStore, loadOrCreateVapid, jsonFileIo } from './hub/push.js'
import { createPushRoutes } from './hub/push-routes.js'
import { createFileLog } from './filelog.js'
import { activeAccountSetter, createLimitSignIn } from './limit-signin.js'
import { STALE_MS, createDismissals, createPausedTracker, scanSessionLogs } from './paused.js'
import { readThread } from './thread.js'
import { sourcesForItem } from './triage-sources.js'
import { snippetsFromThread } from './follow-up.js'
import { createTaskbarBadge } from './taskbar.js'
import { createSurveyLogReader } from './tip-survey.js'
import { CHECK_MS, IDLE_MS, createIdleJudge, createIdleResumer, createLogReader } from './idle-resume.js'
import { ASK_CHECK_MS, ASK_IDLE_MS, BEAT_MS, createIdleAsker, createSleepTracker } from './idle-ask.js'
import { createTriageJudge } from './triage-judge.js'
import { createTriageLog } from './triage-log.js'
import { createTriageRunner, DEFAULT_RULES } from './triage-runner.js'
import { createDoneActor } from './triage-act-done.js'
import { createPermissionActor } from './triage-act-permission.js'
import { createQuestionActor } from './triage-act-question.js'
import { createTriageMemory } from './triage-memory.js'
import { createTriageRules } from './triage-rules.js'
import { createAiReporter, REPORT_INTERVAL_MS } from './ai-reporter.js'
import { createRcNotify } from './ai-report-notify.js'

export const name = 'review-queue'

const HERE = dirname(fileURLToPath(import.meta.url))
const safe = (fn) => { try { return fn() } catch { return undefined } }

/** Atomic-ish JSON file: write a temp file, then rename over the target. */
function fileIo(file) {
  return {
    read: () => { try { return readFileSync(file, 'utf8') } catch { return undefined } },
    write: (text) => { const tmp = file + '.tmp'; writeFileSync(tmp, text); renameSync(tmp, file) },
  }
}

/**
 * Builds every piece of the plugin and returns { queue, local, store, agent, proxy }: queue is what other plugins get as reviewQueue (the hub
 * queue, or the local service when the hub is off), agent the hub connection (undefined when the hub is off); apply() is the DSH entry.
 * config.ui: a { seq, cmd } show/hide state of its own (several apps in one process, tests); config.hubDeps: { launcher, agent, retryMs } overrides for tests.
 */
export function createReviewQueuePlugin(ctx, config = {}) {
  let stateDir
  try {
    stateDir = resolve(config.stateDir ?? join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'review-queue'))
    mkdirSync(stateDir, { recursive: true })
  } catch (error) { ctx.logger?.warn?.('review-queue: state directory unusable (' + String(error) + '); the queue is not persisted'); stateDir = undefined }

  // The web port names this app at the hub. It is read here when the host already has it; otherwise the agent waits for it a moment before it
  // registers (the host may run this callback, or bind the port, after the plugin was applied). The route is registered in the same step and answers once the pieces below exist.
  let webPort
  let handle = (req, res) => { res.statusCode = 503; res.end() }
  // Same pattern as dsh-git-view: ride the Host web server so the browser, Desktop and remote access all reach it, behind
  // the Host's own Host/Origin fence and cookie authentication.
  try {
    ctx.inject(['connection', 'webServer'], (webCtx) => {
      webPort = Number(webCtx.webServer?.port) || undefined
      webCtx.effect(() => webCtx.webServer.register({
        kind: 'prefix',
        path: PREFIX,
        handler: (req, res) => {
          const admission = webCtx.connection.admit(req)
          if ('rejection' in admission) { res.statusCode = admission.rejection; res.end(); return }
          req.url = (req.url ?? '/').slice(PREFIX.length) || '/'
          handle(req, res)
        },
      }), 'review-queue: routes')
    })
  } catch (error) { ctx.logger?.warn?.('review-queue: routes not registered: ' + String(error)) }

  // Every log line also goes to review-queue.log next to queue.json (size capped), so a silent failure can be traced later.
  const fileLog = stateDir ? createFileLog(join(stateDir, 'review-queue.log')) : undefined
  const log = (line) => { ctx.logger?.info?.('review-queue: ' + line); fileLog?.('review-queue: ' + line) }
  const useHub = hubEnabled(config) && stateDir !== undefined
  const instanceId = randomBytes(8).toString('hex')
  const dshHome = process.env.DSH_HOME ?? join(homedir(), '.dsh')
  const servicePort = () => { try { return Number(ctx.get?.('webServer')?.port) || undefined } catch { return undefined } }
  const portNow = () => webPort ?? servicePort()
  const instanceKey = instanceKeyOf({ dshHome, port: portNow() }) // names the local file; a pid key when the port is not known yet
  let store
  if (useHub) {
    // Own items live in local/<instanceKey>.json (also the outbox for the hub); the hub imports the old shared queue.json itself.
    mkdirSync(join(stateDir, 'local'), { recursive: true })
    store = createStoreAdapter({ instanceId, io: fileIo(join(stateDir, 'local', instanceKey + '.json')) })
    log('hub on')
  } else {
    store = createStore({ io: stateDir ? fileIo(join(stateDir, 'queue.json')) : undefined })
    cancelStalePending(store, { log }) // with the hub on, the hub settles the dead requests of an earlier run (agent/wire.js)
  }
  store.prune()

  const llmService = () => { try { return ctx.get?.('llm') ?? ctx.llm } catch { return undefined } }
  const llm = { listProviders: () => llmService().listProviders(), listModels: (p) => llmService().listModels(p), prepareCall: (...a) => llmService().prepareCall(...a) }
  const summarizer = createSummarizer({ llm, log })
  // The images pasted into the new-todo form live next to queue.json, shared by every app and the hub of this PC (a todo can start in another app); files older than a week are pruned.
  const todoImages = stateDir ? createTodoImages({ root: join(stateDir, 'todo-images') }) : undefined
  try { todoImages?.prune() } catch { /* a net, not a need */ }
  // The new-todo form's Tune prompt button: the same llm service, rules from config.promptTunePath (default: the prompt-tune skill file, else an embedded copy).
  const tuner = createTuner({ llm, rulesPath: config.promptTunePath, log })
  // Question auto-answer: questionAutoAnswer (default on), questionAutoAnswerLeadSeconds (0 = off) and questionWindowSeconds (the window of a question
  // the model gave no timeout: must match the ask_user_question timeout row). A value that is not a finite number in range is passed on as undefined: capture.js applies its defaults.
  const msOf = (seconds, zeroOk) => (Number.isFinite(seconds) && (seconds > 0 || (zeroOk && seconds === 0)) ? seconds * 1000 : undefined)
  const capture = installCapture(ctx, {
    store, summarizer, log, autoAnswer: config.questionAutoAnswer !== false,
    autoAnswerLeadMs: msOf(config.questionAutoAnswerLeadSeconds, true), defaultWindowMs: msOf(config.questionWindowSeconds, false),
    keepDone: config.doneKeepPerSession, // capture.js falls back to its default (20) for anything that is not a positive integer
  })
  const controllerOf = () => { try { return ctx.get?.('sessionController') ?? ctx.sessionController } catch { return undefined } }
// The default model selection service: a todo that picks another effort gives the default back after selecting it for its session (todo.js applyEffort).
const defaultModelOf = () => { try { return ctx.get?.('agentDefaultModel') ?? ctx.agentDefaultModel } catch { return undefined } }
  // A prompt typed into a session that mentions an Azure DevOps ticket renames the session "Fix: <ticket title> - <number>" (off with ticketSessionTitles: false).
  installTicketSessions(ctx, { controllerOf, log, enabled: () => config.ticketSessionTitles !== false })
  // The play button speaks through the sibling dsh-hooks-tts plugin's TTS client (same server, mute switch and stop hotkey).
  const reader = createReader({
    spawn,
    script: join(HERE, 'scripts', 'read-aloud.ps1'),
    clientScript: resolve(config.ttsClient ?? join(HERE, '..', 'dsh-hooks-tts', 'scripts', 'tts-client.ps1')),
    powershell: join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
    stateDir: process.env.DSH_TTS_STATE_DIR || join(process.env.TEMP || tmpdir(), 'dsh-tts'),
    gender: config.voice === 'female' ? 'female' : 'male',
    log,
  })
  const identify = async () => {
    const waitMs = config.hubDeps?.portWaitMs
    const port = await awaitPort(portNow, waitMs === undefined ? {} : { timeoutMs: waitMs })
    log('instance key from ' + (port ? 'the web port ' + port : 'the pid (no web port; items are adopted by session)'))
    return { key: port ? instanceKeyOf({ dshHome, port }) : instanceKey, label: instanceLabelOf(config, port) }
  }
  const agentsOf = () => { try { return ctx.get?.('agents') ?? ctx.agents } catch { return undefined } }
  const registryOf = () => { try { return ctx.get?.('workspaceRegistry') ?? ctx.workspaceRegistry } catch { return undefined } }
  // dsh-hooks-tts provides the guard that knows which sessions poll a still-open PR; it is looked up per call, so the plugin load order does not matter and a missing plugin refuses nothing.
  const prGuardOf = () => { try { return ctx.get?.('prArchiveGuard') ?? undefined } catch { return undefined } }
  // Todo: recent session titles help the model pick a workspace (best effort), and a SPARC todo inlines the modes:sparc text like dsh-hooks-tts does.
  const titlesOf = createTitleReader(() => ctx.get?.('sessionQuery'), { log })
  const sparcText = () => {
    try { return readFileSync(resolve(config.sparcCommandPath ?? join(homedir(), '.claude', 'commands', 'modes', 'sparc.md')), 'utf8').replace(/^---[\s\S]*?\n---\s*/, '') } catch { return '' }
  }
  // Every session this app can reach: live agents, the sessions of the workspaces, the ones capture has seen. The hub gives the app the unowned items of these.
  const reachableSessionIds = () => {
    const ids = new Set(capture.seenSessionIds())
    try { for (const agent of agentsOf()?.list?.() ?? []) if (typeof agent?.id === 'string') ids.add(agent.id) } catch { /* the live agents are a bonus */ }
    for (const workspace of listWorkspaces(registryOf) ?? []) for (const id of workspace.sessionIds) ids.add(id)
    return [...ids]
  }
  const speaker = config.speaker ?? reader
  // Paused sessions: what a restart cut off, from the session logs. A session this app has seen or has loaded is live; an archived one is skipped.
  const startedAt = Date.now()
  const pausedWanted = typeof config.pausedScan === 'function' || config.paused === true
    || (config.paused !== false && process.env.DSH_RQ_PAUSED !== '0' && process.env.NODE_TEST_CONTEXT === undefined)
  const archivedIds = () => new Set((safe(() => registryOf()?.archivedSessionIds) ?? []).map(String))
  const liveSessionIds = () => new Set([...capture.seenSessionIds(), ...(safe(() => agentsOf()?.list?.()) ?? []).map((a) => a?.id).filter((id) => typeof id === 'string')])
  const sessionsRoot = join(dshHome, 'sessions')
  const pausedScan = () => (config.pausedScan ?? scanSessionLogs)({ root: sessionsRoot, startedAt, liveIds: liveSessionIds(), skipIds: archivedIds() })
  let onHold // the on-hold queue (onhold.js), created below; the paused scan and the idle check ask it which sessions are parked on purpose
  const heldIds = () => onHold?.heldSessionIds() ?? new Set()
  const paused = pausedWanted
    ? createPausedTracker({
      store, scan: pausedScan, log, heldIds, limitRunning: () => limitSignIn?.state().running === true,
      dismissals: createDismissals({ io: stateDir ? fileIo(join(stateDir, 'paused-dismissed.json')) : undefined }),
    })
    : undefined
  // The session-limit sign-out/sign-in run (limit-signin.js); the routes are in server.js. It does nothing until start({ email }) is called.
  // llm-claude-code's optional 'claudeAccounts' service is read per call (that plugin may load later or not at all); activeAccount is written through the host's
  // server-side settings service (ctx.get('settings').mutate; else the card tells the user to set it). config.limitSignInDeps replaces parts (tests).
  const claudeAccountsOf = () => { try { return ctx.get?.('claudeAccounts') ?? undefined } catch { return undefined } }
  const settingsOf = () => { try { return ctx.get?.('settings') ?? undefined } catch { return undefined } }
  const limitSignIn = createLimitSignIn({
    get accounts() { return claudeAccountsOf() },
    get setActiveAccount() { return activeAccountSetter(settingsOf()) },
    pinned: { set: (p) => paused?.setPinned(p) ?? false },
    dshHome, log, claudeExecutable: config.claudeExecutable,
    ...(config.limitSignInDeps ?? {}),
  })
  // A sign-in run that died (crash, kill, power loss) after the logout left the user signed out with the token backup on disk: undo it now. Never blocks or breaks the start.
  void Promise.resolve().then(() => limitSignIn.recoverStranded()).catch((error) => log('limit-signin: recovery at start failed: ' + String(error?.message ?? error)))
  // The chat view of the phone reads the thread of a session from the same folder.
  const threadOf = (opts) => readThread({ root: join(dshHome, 'sessions'), log, ...opts })
  // The tip of the day of the empty list (tip.js): this app's own model (none while the llm service is missing: built-in tips), steered by the recent work topics. config.tipDeps overrides parts for tests.
  const tipper = createTipper({ llm: () => (llmService() ? llm : undefined), topicsOf: () => recentTopics({ store, titlesOf }), log, ...(config.tipDeps ?? {}) })
  // "Go deeper" and "Use in my code" on that tip (tip-expand.js): the same model and topics; config.tipExpandDeps overrides parts for tests.
  const tipExpand = createExpander({ llm: () => (llmService() ? llm : undefined), tips: tipper, topicsOf: () => recentTopics({ store, titlesOf }), workspacesOf: () => listWorkspaces(registryOf) ?? [], log, ...(config.tipExpandDeps ?? {}) })
  // "N working / M open": this app's sessions from the session controller, cached for 2 s (sessions.js); config.sessionCounter: { ttlMs, minEmitMs } for tests.
  const sessionCounter = createSessionCounter({ controllerOf, registryOf, log, ...(config.sessionCounter ?? {}) })
  // On hold: sessions parked on purpose, in their own queue; one on an Azure DevOps ticket is continued by the plugin when the ticket gets a comment or a state, assignee or description change.
  onHold = createOnHold({ store, controllerOf, ticketStateOf: config.onHoldDeps?.ticketStateOf ?? ((ref) => fetchTicketState(ref, { log })), log })
  // A session goes on hold by "/onhold <reason>" typed in it, or by an ONHOLD marker line it prints itself (off with onHoldCommands: false).
  installOnHoldCommand(ctx, { onHoldOf: () => onHold, log, enabled: () => config.onHoldCommands !== false })
  // A session asks the user to archive it by "/archive-offer <reason>" typed in it or an ARCHIVE-OFFER marker line it prints itself: an archive card (desktop and phone), nothing is archived before the user presses it (off with archiveOfferCommands: false).
  const archiveOfferEnabled = () => config.archiveOfferCommands !== false // shared by the marker/command paths and the queue (the session-link tool archive_self asks it)
  installArchiveOffer(ctx, { queueOf: () => queue, log, enabled: archiveOfferEnabled })
  // AI triage (triage-runner.js) shares ONE rule set and ONE correction memory with the queue, so a mode change or a correction made through the queue acts at once.
  // Off with triage: false or env DSH_RQ_TRIAGE=0, and off in node --test runs unless triage: true; config.triageDeps replaces parts (tests).
  const triageWanted = config.triage === true || (config.triage !== false && process.env.DSH_RQ_TRIAGE !== '0' && process.env.NODE_TEST_CONTEXT === undefined)
  const triageRules = triageWanted ? (config.triageDeps?.triageRules ?? createTriageRules({ io: stateDir ? fileIo(join(stateDir, 'triage-rules.json')) : undefined, defaults: DEFAULT_RULES, log })) : undefined
  // Correction memory (triage-memory.js): reversed AI proposals become lessons, so the same mistake is not proposed again.
  const triageMemory = triageWanted ? (config.triageDeps?.memory ?? createTriageMemory({ io: stateDir ? fileIo(join(stateDir, 'triage-memory.json')) : undefined })) : undefined
  const triageLog = stateDir ? createTriageLog(join(stateDir, 'triage-log.jsonl')) : undefined
  // Hourly AI report: the last report rides the queue snapshot (header chip); voice and chat go out through the same speaker and the RingCentral wrapper.
  const reportObj = typeof config.aiReport === 'object' && config.aiReport !== null
  const reportCfg = reportObj ? config.aiReport : {}
  const reportWanted = config.aiReport === true || reportObj || (config.aiReport !== false && process.env.DSH_RQ_AI_REPORT !== '0' && process.env.NODE_TEST_CONTEXT === undefined)
  const reportDeps = config.aiReportDeps ?? {}
  const aiReporter = reportWanted
    ? createAiReporter({
      store, triageLog, log, speaker: reportDeps.speaker ?? speaker, now: reportDeps.now, channels: { voice: reportCfg.voice, chat: reportCfg.chat },
      intervalMs: Number.isFinite(reportCfg.intervalMinutes) && reportCfg.intervalMinutes > 0 ? reportCfg.intervalMinutes * 60_000 : REPORT_INTERVAL_MS,
      io: stateDir ? fileIo(join(stateDir, 'ai-report.json')) : undefined,
      notify: reportDeps.notify ?? createRcNotify({
        spawn: reportDeps.spawn ?? spawn, script: join(HERE, 'scripts', 'rc-notify.ps1'), envFile: reportCfg.rcEnvFile, log,
        powershell: join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
      }),
    })
    : undefined
  // dsh-hooks-tts's 'handoffFollowUp' service (read per call: that plugin may load later or not at all).
  const handoffFollowOf = () => { try { return ctx.get?.('handoffFollowUp') ?? undefined } catch { return undefined } }
  // "Find places" (tip-survey.js): the survey is built by the queue over its own todos; the session log is read by the survey's own settled-log reader (createSurveyLogReader), the workspaces are this app's own registry (a hub workspace is refused),
  // the tip is looked up by id while it is the current one, and the ADO calls read the PAT from the environment inside ado-create.js only. config.tipSurveyDeps replaces parts (tests).
  const tipSurveyDeps = {
    readLog: createSurveyLogReader({ root: sessionsRoot }),
    workspacesOf: () => listWorkspaces(registryOf) ?? [],
    tipOf: (id) => { try { const tip = tipper.peek(); return tip && tip.id === id ? tip : undefined } catch { return undefined } },
    adoBaseOf: (path) => adoBaseOf(path),
    createTask: (base, task) => createTask(base, task, { env: process.env, log }),
    log,
    ...(config.tipSurveyDeps ?? {}),
  }
  const queue = createReviewQueue({ store, capture, controllerOf, defaultModelOf, limitSignIn, archiveOfferEnabled, handoffFollowOf, onHold, instanceId, registryOf, prGuardOf, speaker, llm, tuner, tips: tipper, tipExpand, tipSurveyDeps, sessions: sessionCounter, titlesOf, snippetsOf: snippetsFromThread(threadOf), sparcText, log, paused, threadOf, todoImages, ...(aiReporter ? { aiReportOf: aiReporter.last } : {}), ...(triageWanted ? { triageApi: { rules: triageRules, memory: triageMemory } } : {}), ...(config.ui ? { ui: config.ui } : {}) })
  // Observe mode only: every new item is judged in the background and an open card that is safe to handle gets the note "AI would have handled this". Nothing is ever done to an item.
  let triage
  if (triageWanted) {
    try { triageLog?.prune() } catch { /* next start */ }
    triage = createTriageRunner({
      store, log, triageLog, memory: triageMemory, rules: () => triageRules.current(),
      actors: { done: createDoneActor({ store }), permission: createPermissionActor({ store, decide: (id, resolution) => capture.decidePermission(id, 'approve', { resolution }) }), question: createQuestionActor({ store, answer: (id, answers, resolution) => capture.answerQuestion(id, answers, { resolution }) }) }, // inert while every rule is in observe
      judge: config.triageDeps?.judge ?? createTriageJudge({ llm, log }),
      // A question may only be answered from what the user wrote earlier in the session: its thread, user messages only.
      sourcesOf: sourcesForItem(threadOf),
      enabled: () => config.triage !== false && safe(() => triageRules.enabled?.()) === true, // fail closed: a missing, throwing or non-true switch counts as off
      // A session parked on hold is never a candidate (a user mark that vetoes triage).
      marksOf: (item) => ({ onHold: safe(() => heldIds().has(item.sessionId)) === true }),
      // A done card is raised when a turn ends, so a session that is running again by now is one that continues; unknown means finished (a veto only for an auto rule).
      sessionContinuesOf: (item) => safe(() => sessionCounter.runningIds?.()?.has(item.sessionId)) === true,
      ...(config.triageDeps ?? {}),
    })
    triage.start()
  }
  aiReporter?.start()
  const pausedTimers = []
  if (paused) {
    const later = (ms) => { const t = setTimeout(() => { void paused.scan() }, ms); t.unref?.(); pausedTimers.push(t) }
    later(config.pausedStartMs ?? 5000)
    const again = config.pausedRescanMs ?? STALE_MS + 15_000
    if (again > 0) later((config.pausedStartMs ?? 5000) + again)
  }

  // Idle sessions: the periodic check (idle-resume.js). A resumed session closes its paused card; one the model is unsure about becomes a paused card (kinds ['idle']) that the user resumes or dismisses.
  const idleWanted = config.idleResume === true || (config.idleResume !== false && process.env.DSH_RQ_IDLE_RESUME !== '0' && process.env.NODE_TEST_CONTEXT === undefined)
  const idleMs = Number.isFinite(config.idleMinutes) && config.idleMinutes > 0 ? config.idleMinutes * 60_000 : IDLE_MS
  const openPausedOf = (sessionId) => store.list({ status: 'open' }).filter((i) => i.type === 'paused' && i.sessionId === sessionId)
  const idle = idleWanted
    ? createIdleResumer({
      controllerOf, registryOf, startedAt, idleMs, log, heldIds,
      readLog: config.idleDeps?.readLog ?? createLogReader({ root: sessionsRoot }),
      judge: config.idleDeps?.judge ?? createIdleJudge({ llm, log }),
      io: stateDir ? fileIo(join(stateDir, 'idle-resume.json')) : undefined,
      resumed: (c) => { for (const item of openPausedOf(c.sessionId)) { paused?.markHandled(item); store.resolve(item.id, { kind: 'resumed', by: 'idle-check' }) } },
      unsure: (c) => {
        if (openPausedOf(c.sessionId).length) return
        const minutes = Math.max(1, Math.round((Date.now() - c.lastWrite) / 60_000))
        store.add({
          type: 'paused', sessionId: c.sessionId, sessionTitle: c.title, workspace: c.cwd,
          payload: { lastWrite: c.lastWrite, kinds: ['idle'], reason: 'Idle for ' + minutes + ' min; not sure it needs resuming' + (c.reason ? ': ' + c.reason : ''), turn: 0, danglingCalls: [], pending: 0, lastUser: c.lastUser.slice(0, 160), lastAssistant: c.lastAssistant.slice(-160) },
        })
      },
    })
    : undefined
  const idleTimers = []
  if (idle) {
    const first = setTimeout(() => { void idle.check() }, config.idleStartMs ?? 60_000)
    first.unref?.()
    idleTimers.push(first)
    const every = config.idleCheckMs ?? CHECK_MS
    if (every > 0) { const t = setInterval(() => { void idle.check() }, every); t.unref?.(); idleTimers.push(t) }
  }

  // Idle ask (idle-ask.js): off unless idleAsk: true or env DSH_RQ_IDLE_ASK=1. Every idleAskCheckMs (10 min) a session that is not working and was idle for idleAskMinutes (60) of awake time since its last prompt or
  // last logged activity (laptop sleep is deducted by a heartbeat) is asked, in that session, whether to continue or archive it; an Archive answer archives it.
  const askWanted = config.idleAsk === true || (config.idleAsk !== false && process.env.DSH_RQ_IDLE_ASK === '1')
  const askTimers = []
  if (askWanted) {
    const sleep = createSleepTracker({ io: stateDir ? fileIo(join(stateDir, 'sleep.json')) : undefined })
    const asker = createIdleAsker({
      controllerOf, registryOf, prGuardOf, store, sleep, heldIds, log, startedAt, titlesOf,
      readLog: config.idleDeps?.readLog ?? createLogReader({ root: sessionsRoot }),
      idleMs: Number.isFinite(config.idleAskMinutes) && config.idleAskMinutes > 0 ? config.idleAskMinutes * 60_000 : ASK_IDLE_MS,
      io: stateDir ? fileIo(join(stateDir, 'idle-ask.json')) : undefined,
    })
    sleep.beat()
    const beat = setInterval(() => sleep.beat(), BEAT_MS); beat.unref?.()
    const first = setTimeout(() => { void asker.check() }, config.idleAskStartMs ?? 90_000); first.unref?.()
    const every = setInterval(() => { void asker.check() }, config.idleAskCheckMs ?? ASK_CHECK_MS); every.unref?.()
    askTimers.push(beat, first, every)
    store.onChange(() => { void asker.archiveAnswered() })
  }

  // The ticket check of the held sessions every onHoldCheckMs (default 10 minutes; 0 turns it off; off in node --test runs unless onHoldCheckMs is set).
  const holdTimers = []
  const holdEvery = Number.isFinite(config.onHoldCheckMs) ? config.onHoldCheckMs : (process.env.NODE_TEST_CONTEXT === undefined ? 10 * 60_000 : 0)
  if (holdEvery > 0) {
    const first = setTimeout(() => { void onHold.check() }, config.onHoldStartMs ?? 60_000)
    first.unref?.()
    const t = setInterval(() => { void onHold.check() }, holdEvery)
    t.unref?.()
    holdTimers.push(first, t)
  }

  // Expired questions and done messages with nothing to do leave the list by themselves (auto-clear.js); every autoClearMs (default 2 s; 0 = off, and off in node --test runs unless set).
  const autoClearEvery = Number.isFinite(config.autoClearMs) ? config.autoClearMs : (process.env.NODE_TEST_CONTEXT === undefined ? 2000 : 0)
  const autoClear = createAutoClear({ store, log })
  const autoClearTimer = autoClearEvery > 0 ? setInterval(() => autoClear.sweep(), autoClearEvery) : undefined
  autoClearTimer?.unref?.()
  const pruneTimer = setInterval(() => { store.prune(); try { todoImages?.prune() } catch { /* next hour */ } }, 3600_000)
  pruneTimer.unref?.()
  // The session numbers are looked at every few seconds, so a change reaches the open screens by itself (the counter caches and rate limits the events).
  const sessionsTimer = setInterval(() => { void queue.refreshSessions() }, config.sessionsRefreshMs ?? 5000)
  sessionsTimer.unref?.()
  let wiring
  ctx.effect?.(() => async () => { clearInterval(autoClearTimer); clearInterval(pruneTimer); clearInterval(sessionsTimer); triage?.stop(); aiReporter?.stop(); queue.stopTipSurvey?.(); pausedTimers.forEach(clearTimeout); try { let cancelTimer; await Promise.race([(async () => { await limitSignIn.cancel(); await limitSignIn.whenDone() })(), new Promise((resolve) => { cancelTimer = setTimeout(() => { log('limit-signin: cancel at shutdown timed out'); resolve() }, config.limitCancelTimeoutMs ?? 10_000); cancelTimer.unref?.() })]).finally(() => clearTimeout(cancelTimer)) } catch (error) { log('limit-signin: cancel at shutdown failed: ' + String(error?.message ?? error)) } idleTimers.forEach((t) => { clearTimeout(t); clearInterval(t) }); askTimers.forEach((t) => { clearTimeout(t); clearInterval(t) }); holdTimers.forEach((t) => { clearTimeout(t); clearInterval(t) }); capture.dispose(); reader.stop(); await taskbar?.dispose(); await wiring?.dispose() }, 'review-queue: stop')

  // Dev route: drive the real handlers with a fake agent so the whole path (item, card answer, expiry) can be tried
  // without a model. Off unless asked for.
  let dev
  if (config.dev === true || process.env.DSH_REVIEW_QUEUE_DEV === '1') {
    let n = 0
    const never = () => new Promise(() => {})
    dev = {
      async ask(body) {
        const agent = { id: typeof body.sessionId === 'string' && body.sessionId ? body.sessionId : 'dev-' + ++n, devTitle: String(body.title ?? 'Dev session'), session: { header: { cwd: 'D:/dev' }, deriveMessages: () => [{ role: 'assistant', content: String(body.reply ?? 'Done.') }] } }
        if (body.kind === 'question') {
          const ac = new AbortController()
          const seconds = Number.isInteger(body.timeoutSec) ? body.timeoutSec : 0
          const callId = 'dev-call-' + n
          if (seconds > 0) {
            await capture.handlers['tools/pre-execute']({ name: 'ask_user_question', callId, arguments: { timeout: seconds }, agent }, async () => ({}))
            setTimeout(() => ac.abort(Object.assign(new Error('timed out'), { code: 'ASK_TIMED_OUT' })), seconds * 1000).unref?.()
          }
          void capture.handlers['user-questions/request']({ agent, questions: body.questions, signal: ac.signal, wait: { callId, timed: seconds > 0 } }, never).catch(() => {})
        } else if (body.kind === 'permission') {
          const callId = 'dev-perm-' + n
          await capture.handlers['tools/pre-execute']({ name: String(body.toolName ?? 'shell'), callId, arguments: { command: String(body.command ?? 'echo hi') }, agent }, async () => ({}))
          void capture.handlers['approval/request']({ agent, toolName: String(body.toolName ?? 'shell'), callId }, never).catch(() => {})
        } else {
          await capture.handlers['agent/turn-stopping']({ agent })
        }
        return { ok: true }
      },
    }
  }
  // Phone notifications. Standalone (hub off): the VAPID key pair and the registered devices live next to queue.json (private files); delivery is injectable.
  // With the hub on they belong to the hub (hub/hub.js: key pair, subscriptions per paired device, notifier), so this app keeps none and has no push routes.
  let pushRoutes
  if (!useHub) {
    const vapid = loadOrCreateVapid({ io: stateDir ? jsonFileIo(join(stateDir, 'vapid.json'), { mode: 0o600 }) : undefined, subject: config.pushSubject })
    const push = createPushStore({ io: stateDir ? jsonFileIo(join(stateDir, 'push.json'), { mode: 0o600 }) : undefined, vapid, ...(typeof config.sendPush === 'function' ? { sendPush: config.sendPush } : {}) })
    pushRoutes = createPushRoutes({ push, publicKey: vapid.publicKey })
  }
  const makeServe = (served) => createRouter({ queue: served, dev, pushRoutes })

  // Hub mode: reads and actions go through the hub, the instance routes through the proxy; the local service stays alive underneath.
  let provided = queue
  if (useHub) {
    wiring = wireHub({
      stateDir, port: hubPortOf({ hubPort: config.hubPort }), hubNode: config.hubNode, instanceKey, instanceId, label: instanceLabelOf(config, webPort), adapter: store, local: queue, makeServe, speaker,
      controllerOf, workspaces: () => listWorkspaces(registryOf) ?? [], sessionIds: reachableSessionIds, identify, log, deps: config.hubDeps,
    })
    provided = wiring.hubQueue
    handle = (req, res) => wiring.proxy.handle(req, res)
    wiring.start()
  } else handle = makeServe(queue)

  // The waiting count as a badge on the taskbar button. Off in node --test runs (they set NODE_TEST_CONTEXT) unless a test asks with taskbarBadge: true.
  const badgeWanted = config.taskbarBadge === true || (config.taskbarBadge !== false && process.env.DSH_RQ_TASKBAR !== '0' && process.env.NODE_TEST_CONTEXT === undefined)
  const taskbar = badgeWanted
    ? createTaskbarBadge({
      queue: provided, spawn: config.badgeDeps?.spawn ?? spawn, script: join(HERE, 'scripts', 'taskbar-badge.ps1'), pid: process.pid, log,
      powershell: join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
      ...(config.badgeDeps ?? {}),
    })
    : undefined

  // Other plugins (voice) reach the queue through the context.
  try { ctx.provide?.('reviewQueue', provided) } catch { /* optional */ }
  return { queue: provided, local: queue, agent: wiring?.client, proxy: wiring?.proxy, store, idle, aiReporter, limitSignIn }
}

export function apply(ctx, config = {}) {
  return createReviewQueuePlugin(ctx, config).queue
}
