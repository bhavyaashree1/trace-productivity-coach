import express, { Request, Response } from 'express';
import dotenv from 'dotenv';
import crypto from 'crypto';
import { verifyTraceSignature } from './hmac';
import {
  createSession,
  db,
  endActiveSession,
  ensureUser,
  getActiveSession,
  getConnectorStatus,
  getLatestVisualContext,
  getTodaySummary,
  getUserState,
  initDb,
  insertEnergyLog,
  insertEvent,
  insertVisualContext,
  recordNudge,
  updateUserState,
  wasNudgeSentRecently,
} from './db';
import { buildNextTaskRecommendation, buildPatternSummary } from './insights';
import { connectorStatuses, getCalendarAnalysis, getEmailAnalysis, getSocialConnectorSummary, missingConnectorPrompt } from './connectors';
import { ConnectorKey, Energy, ParsedIntent, Scene } from './types';

dotenv.config();

const app = express();
const PORT = Number(process.env.PORT || 3000);
const TRACE_HMAC_SECRET = process.env.TRACE_HMAC_SECRET || '';
const TRACE_SKILL_ID = process.env.TRACE_SKILL_ID || '';
const BRAIN_BASE_URL = process.env.BRAIN_BASE_URL || 'https://brain.endlessriver.ai';
const CRON_SECRET = process.env.CRON_SECRET || '';

app.use(express.json({ verify: (req: any, _res, buf) => { req.rawBody = buf; } }));

function parseIntent(utterance: string): ParsedIntent {
  const i = utterance.trim().toLowerCase();
  if (/(starting|beginning|working on|i'm starting|i am starting)/.test(i)) {
    return { intent: 'START', taskLabel: utterance.replace(/^(i'?m|i am)?\s*(starting|beginning)\s*/i, '').trim() || utterance.trim() };
  }
  if (/(i'?m done|i am done|finished|wrapping up|end session)/.test(i)) return { intent: 'END' };
  if (/(my energy is|energy is|i feel)\s+(low|medium|high|tired|drained|great)/.test(i)) {
    const raw = (i.match(/(low|medium|high|tired|drained|great)/)?.[1] || '').toLowerCase();
    const energy: Energy = ['tired', 'drained', 'low'].includes(raw) ? 'low' : raw === 'medium' ? 'medium' : raw ? 'high' : null;
    return { intent: 'ENERGY', energy };
  }
  if (/(when should i take a break|can i take( a)? (lunch )?break|should i take( a)? break|is it time for a break|how long have i been)/.test(i)) return { intent: 'BREAK_QUERY' };
  if (/(what should i work on|what do i do next|next task|suggest)/.test(i)) return { intent: 'NEXT_TASK' };
  if (/(summary|recap|how productive|when am i most productive|patterns|habit|circadian)/.test(i)) return { intent: 'SUMMARY' };
  if (/(block this on my calendar|schedule this|put this on my calendar)/.test(i)) return { intent: 'CALENDAR_BLOCK' };
  if (/(email summary|analyze my email|check my inbox)/.test(i)) return { intent: 'EMAIL_SUMMARY' };
  if (/(overwhelmed|scattered|not in the right headspace|too much)/.test(i)) return { intent: 'OVERWHELM' };
  return { intent: 'UNKNOWN' };
}

function classifyScene(description: string): { scene: Scene; notes: string; confidence: number; inferredStatus: string | null } {
  const d = (description || '').toLowerCase();
  if (!d) return { scene: 'unknown', notes: 'No image description provided by platform.', confidence: 0.2, inferredStatus: null };
  if (/meeting|conference|whiteboard|group|presentation/.test(d)) return { scene: 'meeting_room', notes: 'Meeting-like environment detected.', confidence: 0.9, inferredStatus: 'meeting' };
  if (/eat|coffee|food|lunch|meal|snack|cafe|drink/.test(d)) return { scene: 'eating', notes: 'Food or drink break detected.', confidence: 0.88, inferredStatus: 'break' };
  if (/phone|scroll|social|texting/.test(d)) return { scene: 'phone_scrolling', notes: 'Phone use detected.', confidence: 0.82, inferredStatus: 'break' };
  if (/rest|bed|couch|sofa|lying/.test(d)) return { scene: 'resting', notes: 'Resting state detected.', confidence: 0.85, inferredStatus: 'break' };
  if (/away from desk|outside|walking|kitchen|living room/.test(d)) return { scene: 'away_from_desk', notes: 'Away from desk.', confidence: 0.8, inferredStatus: 'idle' };
  if (/laptop|monitor|desk|keyboard|screen|typing|document|spreadsheet|code/.test(d)) {
    return /typing|document|spreadsheet|code|writing/.test(d)
      ? { scene: 'desk_working', notes: 'Active desk work detected.', confidence: 0.87, inferredStatus: 'working' }
      : { scene: 'desk_idle', notes: 'At desk but not clearly working.', confidence: 0.7, inferredStatus: 'idle' };
  }
  return { scene: 'unknown', notes: 'Scene uncertain.', confidence: 0.4, inferredStatus: null };
}

function recommendedBlock(energy: Energy) {
  if (energy === 'high') return { focus: 90, break: 15 };
  if (energy === 'medium') return { focus: 50, break: 10 };
  if (energy === 'low') return { focus: 25, break: 10 };
  return { focus: 50, break: 10 };
}

function connectorToolName(connector: ConnectorKey): string {
  const map: { [K in ConnectorKey]: string } = {
    calendar: 'calendar',
    email: 'email',
    instagram: 'instagram',
    calendly: 'calendly',
    facebook: 'facebook',
  };
  return map[connector];
}
async function postCallback(callbackUrl: string, requestId: string, responses: any[]) {
  const body = JSON.stringify({ request_id: requestId, status: 'success', responses });
  const timestamp = Date.now().toString();
  const signature = 'sha256=' + crypto.createHmac('sha256', TRACE_HMAC_SECRET).update(`${timestamp}.${body}`).digest('hex');
  const res = await fetch(callbackUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Trace-Timestamp': timestamp, 'X-Trace-Signature': signature },
    body,
  });
  console.log(`[Callback] ${res.status}`);
}

async function sendPushResponse(userId: string, responses: any[]) {
  if (!TRACE_SKILL_ID) return;
  const res = await fetch(`${BRAIN_BASE_URL}/api/skill-push/${TRACE_SKILL_ID}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${TRACE_HMAC_SECRET}` },
    body: JSON.stringify({ user_id: userId, responses }),
  });
  if (!res.ok) console.error('[Push]', res.status, await res.text());
}

function buildMcpResponse(id: any, text: string, extraResponses: any[] = []) {
  return {
    jsonrpc: '2.0', id,
    result: {
      content: [
        { type: 'text', text },
        { type: 'embedded_responses', responses: extraResponses }
      ]
    }
  };
}

function buildTruthCheckMessage(scene: Scene, intent: ParsedIntent['intent'], currentStatus: string | null) {
  if (intent === 'START' && ['eating', 'resting', 'away_from_desk'].includes(scene)) return `Before I log that — the latest visual context suggests you may still be on a break or away from work.`;
  if (intent === 'BREAK_QUERY' && scene === 'desk_working') return `The latest visual context suggests you are still actively working.`;
  if (intent === 'START' && scene === 'meeting_room') return `The latest visual context looks more like a meeting environment than solo deep work.`;
  if (currentStatus === 'break' && intent === 'START' && scene === 'eating') return `You were previously on a break, and the latest visual context still looks like a break.`;
  return '';
}

async function buildConnectorIntegrationNudge(userId: string, connector: ConnectorKey) {
  const statuses = await connectorStatuses(userId);
  if (statuses[connector]) return null;
  return missingConnectorPrompt(connector);
}
type SkillReply = {
  text: string;
  extraResponses: any[];
};
async function replyForUtterance(userId: string, utterance: string, timezone: string): Promise<SkillReply> {  const parsed = parseIntent(utterance);
  const active = await getActiveSession(userId);
  const state = await getUserState(userId);
  const visual = await getLatestVisualContext(userId);
  const currentEnergy: Energy = state?.current_energy || null;
  const currentStatus = state?.current_status || null;
  const truthCheck = visual && Date.now() - new Date(visual.observed_at).getTime() < 15 * 60 * 1000
    ? buildTruthCheckMessage(visual.scene_type, parsed.intent, currentStatus)
    : '';

  const extraResponses: any[] = [
    { type: 'feed_item', content: { title: 'Focus Flow Coach', story: utterance } }
  ];

  if (parsed.intent === 'START') {
    const session = await createSession(userId, parsed.taskLabel || utterance, { truth_scene: visual?.scene_type || null });
    await updateUserState(userId, {
      timezone,
      current_status: 'working',
      current_task: parsed.taskLabel || utterance,
      current_session_id: session.id,
    });
    await insertEvent(userId, 'session_started', { task: parsed.taskLabel || utterance, truth_scene: visual?.scene_type || null });
    const prompt = truthCheck
      ? `${truthCheck} If you're definitely resuming work, that's fine — I'll log it now.`
      : `Got it. Starting a work session on "${parsed.taskLabel || utterance}".`;
    return { text: `${prompt} Before you dive in — how's your energy: low, medium, or high?`, extraResponses };
  }

  if (parsed.intent === 'ENERGY' && parsed.energy) {
    await insertEnergyLog(userId, parsed.energy, null, { source: 'voice' });
    await updateUserState(userId, { current_energy: parsed.energy });
    await insertEvent(userId, 'energy_logged', { energy: parsed.energy });
    const rec = recommendedBlock(parsed.energy);
    return { text: `Logged — your energy is ${parsed.energy}. Aim for a ${rec.focus}-minute focus block followed by a ${rec.break}-minute break.`, extraResponses };
  }

  if (parsed.intent === 'BREAK_QUERY') {
    if (!active) return { text: `You don't have an active work session logged right now. If you're starting again, tell me what you're working on and I'll track it.`, extraResponses };
    const started = new Date(active.started_at).getTime();
    const elapsed = Math.max(0, Math.floor((Date.now() - started) / 60000));
    const rec = recommendedBlock(currentEnergy);
    const advice = elapsed >= rec.focus
      ? `You've hit your focus block. Take a ${rec.break}-minute break now.`
      : `You've been working for ${elapsed} minutes. Your recommended block is ${rec.focus} minutes, so you have about ${rec.focus - elapsed} minutes left.`;
    return { text: `${truthCheck ? `${truthCheck} ` : ''}${advice}`, extraResponses };
  }

  if (parsed.intent === 'END') {
    const ended = await endActiveSession(userId);
    if (!ended) return { text: `I don't have an active session to end.`, extraResponses };
    await updateUserState(userId, { current_status: 'idle', current_task: null, current_session_id: null });
    await insertEvent(userId, 'session_ended', { session_id: ended.id, duration_min: ended.duration_min });
    return { text: `Session ended. Nice work. You logged about ${ended.duration_min || 0} minutes.`, extraResponses };
  }

  if (parsed.intent === 'CALENDAR_BLOCK') {
    const statuses = await getConnectorStatus(userId);
    if (!statuses.calendar) {
      return { text: await buildConnectorIntegrationNudge(userId, 'calendar') || missingConnectorPrompt('calendar'), extraResponses };
    }
    if (!active) return { text: `Start a session first so I know what to block on your calendar.`, extraResponses };
    const rec = recommendedBlock(currentEnergy);
    const end = new Date(Date.now() + rec.focus * 60000).toISOString();
    extraResponses.push({
      type: 'tool_call',
      tool: 'calendar.create',
      params: {
        title: active.task_label,
        start: new Date().toISOString(),
        end,
        description: `Blocked by Focus Flow Coach. Energy: ${currentEnergy || 'unknown'}.`,
      }
    });
    await insertEvent(userId, 'calendar_block_requested', { task: active.task_label });
    return { text: `Okay — I'm blocking "${active.task_label}" on your calendar for the next ${rec.focus} minutes.`, extraResponses };
  }

  if (parsed.intent === 'EMAIL_SUMMARY') {
    const email = await getEmailAnalysis(userId);
    return { text: email.ok ? email.summary : email.reason, extraResponses };
  }

  if (parsed.intent === 'NEXT_TASK') {
    const calendar = await getCalendarAnalysis(userId);
    const social = await getSocialConnectorSummary(userId);
    const recommendation = await buildNextTaskRecommendation(userId, currentEnergy);
    const calendarLine = calendar.ok ? calendar.summary : calendar.reason;
    return {
      text: `${recommendation} ${calendarLine} ${social}`,
      extraResponses,
    };
  }

  if (parsed.intent === 'OVERWHELM') {
    await updateUserState(userId, { current_mood: 'overwhelmed' });
    return { text: `That's okay. Don't force the whole task right now. Open the file, write three bullets, or do the smallest visible next step.`, extraResponses };
  }

  if (parsed.intent === 'SUMMARY') {
    const today = await getTodaySummary(userId);
    const patterns = await buildPatternSummary(userId);
    const email = await getEmailAnalysis(userId);
    const calendar = await getCalendarAnalysis(userId);
    return {
      text: `Today you have ${today.sessions} logged sessions totalling ${today.total_minutes} minutes. ${patterns} ${calendar.ok ? calendar.summary : calendar.reason} ${email.ok ? email.summary : email.reason}`,
      extraResponses,
    };
  }

  return {
    text: `I can help you start sessions, log energy, time breaks, block time on your calendar, analyze connected tools, and build productivity patterns.`,
    extraResponses,
  };
}

app.get('/health', async (_req, res) => {
  try {
    await db.query('select 1');
    res.json({ ok: true, service: 'focus-flow-coach', db: true });
  } catch {
    res.status(500).json({ ok: false, db: false });
  }
});

app.post('/mcp', async (req: Request, res: Response) => {
  const { jsonrpc, method, params, id } = req.body;
  if (jsonrpc !== '2.0') return res.status(400).send('Invalid JSON-RPC');

  if (method === 'tools/list') {
    return res.json({
      jsonrpc: '2.0',
      id,
      result: {
        tools: [{
          name: 'handle_dialog',
          description: 'Productivity coaching, truth-checking, persistent memory, connector-aware suggestions, calendar blocking, and summaries.',
          inputSchema: {
            type: 'object',
            properties: { utterance: { type: 'string' } },
            required: ['utterance']
          }
        }]
      }
    });
  }

  if (method === 'tools/call') {
    const { name, arguments: args } = params || {};
    if (name === 'handle_dialog') {
      const utterance = String(args?.utterance || '');
      const userId = req.body?.user?.id || req.body?.userId || 'dev-user';
      const timezone = req.body?.user?.timezone || 'UTC';
      const imageDescription = req.body?.context?.imageDescription as string | undefined;

      await ensureUser(userId, timezone);

      if (imageDescription && imageDescription.trim()) {
        const scene = classifyScene(imageDescription);
        await insertVisualContext(userId, scene.scene, imageDescription, scene.confidence, scene.inferredStatus, { source: 'mcp_context' });
        await insertEvent(userId, 'visual_context_inline', { scene: scene.scene, description: imageDescription });
      }

      const reply = await replyForUtterance(userId, utterance, timezone);
      console.log('[MCP]', userId, utterance, '->', reply.text);
    }
  }

  return res.status(404).json({ jsonrpc: '2.0', id, error: { code: -32601, message: 'Method not found' } });
});

app.post('/webhook', verifyTraceSignature(TRACE_HMAC_SECRET), async (req: Request, res: Response) => {
  const { event, user, request_id, callback_url } = req.body;
  const userId = user?.id;
  console.log('[Webhook]', event?.channel, userId);
  res.status(202).json({ status: 'accepted' });

  const responses: any[] = [];

  try {
    await ensureUser(userId, user?.timezone || 'UTC');

    if (['media.photo', 'instant.image', 'media.video'].includes(event?.channel)) {
      const description = event?.data?.imageDescription || event?.data?.description || event?.data?.caption || '';
      const scene = classifyScene(description);
      await insertVisualContext(userId, scene.scene, description, scene.confidence, scene.inferredStatus, { channel: event.channel });
      await insertEvent(userId, 'visual_context', { channel: event.channel, scene: scene.scene, description });

      const active = await getActiveSession(userId);
      const state = await getUserState(userId);

      if (active && scene.scene === 'eating') {
        await updateUserState(userId, { current_status: 'break' });
        responses.push({
          type: 'notification',
          content: {
            title: 'Break context detected',
            body: `I can see food or drink in front of you. If this is a real break, say "I'm back" when you're ready to resume.`
          }
        });
      }

      if (active && scene.scene === 'phone_scrolling') {
        responses.push({
          type: 'notification',
          content: {
            title: 'Focus drift detected',
            body: `Your current session is still active. If you're distracted, take a deliberate short reset instead of a half-break.`
          }
        });
      }

      if (!active && scene.scene === 'desk_working') {
        responses.push({
          type: 'notification',
          content: {
            title: 'Untracked work',
            body: `Looks like you're working, but no session is active. Tell me what you're working on and I'll track it.`
          }
        });
      }

      if (state?.current_status === 'break' && scene.scene === 'desk_working') {
        responses.push({
          type: 'notification',
          content: {
            title: 'Looks like you are back',
            body: `I can see you may be back at work. Say "I am back" or tell me what you're working on and I will resume tracking.`
          }
        });
      }
    }

    if (event?.channel === 'device.context') {
      await insertEvent(userId, 'device_context', event?.data || {});
      if (typeof event?.data?.battery === 'number' && event.data.battery <= 15) {
        responses.push({
          type: 'notification',
          content: { title: 'Low battery', body: `Battery is ${event.data.battery}%. Consider wrapping up or charging soon.` }
        });
      }
    }

    if (responses.length) await postCallback(callback_url, request_id, responses);
  } catch (err) {
    console.error('[Webhook] processing error', err);
  }
});

app.post('/cron/nudges', async (req: Request, res: Response) => {
  if (!CRON_SECRET || req.headers['x-cron-secret'] !== CRON_SECRET) {
    return res.status(401).json({ error: 'unauthorized' });
  }

  const { rows } = await db.query(`
    select s.id, s.user_id, s.task_label, s.started_at, us.current_energy
    from sessions s
    left join user_state us on us.user_id=s.user_id
    where s.status='active'
  `);

  let nudgesSent = 0;

  for (const row of rows) {
    const elapsed = Math.max(0, Math.floor((Date.now() - new Date(row.started_at).getTime()) / 60000));
    const rec = recommendedBlock(row.current_energy || null);

    if (elapsed >= rec.focus) {
      const sentRecently = await wasNudgeSentRecently(row.user_id, 'break_reminder', 30);
      if (!sentRecently) {
        await sendPushResponse(row.user_id, [{
          type: 'notification',
          content: {
            title: 'Time for a break',
            body: `You've been working on "${row.task_label}" for ${elapsed} minutes. Take a ${rec.break}-minute break now.`
          }
        }]);
        await recordNudge(row.user_id, 'break_reminder');
        nudgesSent += 1;
      }
    }
  }

  res.json({ ok: true, nudges_sent: nudgesSent });
});

app.post('/delete-user', async (req: Request, res: Response) => {
  const { user_id } = req.body;
  if (!user_id) return res.status(400).json({ error: 'missing user_id' });
  await db.query(`delete from users where id=$1`, [user_id]);
  res.json({ ok: true });
});

initDb().then(() => {
  app.listen(PORT, () => console.log(`🚀 Focus Flow Coach running on ${PORT}`));
}).catch(err => {
  console.error('DB init failed', err);
  process.exit(1);
});