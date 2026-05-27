import { ConnectorKey, ConnectorStatusMap } from './types';
import { getConnectorCache, getConnectorStatus, setConnectorCache } from './db';

type ConnectorResult =
  | { ok: true; summary: string; events?: any[]; focusWindows?: string[]; actions?: string[] }
  | { ok: false; reason: string };

export async function connectorStatuses(userId: string): Promise<ConnectorStatusMap> {
  return getConnectorStatus(userId);
}

export function missingConnectorPrompt(connector: ConnectorKey): string {
  const labels: Record<ConnectorKey, string> = {
    calendar: 'Calendar',
    email: 'Email',
    instagram: 'Instagram',
    calendly: 'Calendly',
    facebook: 'Facebook',
  };

  return `${labels[connector]} connector is not active yet. Please enable it through Trace connectors/settings, then I can use it here.`;
}

export async function getCalendarAnalysis(userId: string): Promise<ConnectorResult> {
  const connected = await getConnectorStatus(userId);

  if (!connected.calendar) {
    return {
      ok: false,
      reason: missingConnectorPrompt('calendar'),
    };
  }

  const payload = await getConnectorCache(userId, 'calendar', 'upcoming_events');

  if (!payload) {
    return {
      ok: true,
      summary:
        'Calendar connector is active, but no synced upcoming events are cached yet. Once Trace exposes readable connector payloads or sync webhooks, this will analyze your schedule in more depth.',
      events: [],
      focusWindows: [],
    };
  }

  const events = Array.isArray(payload?.events) ? payload.events : [];
  const focusWindows = computeFocusWindows(events);

  return {
    ok: true,
    summary: buildCalendarSummary(events, focusWindows),
    events,
    focusWindows,
  };
}

export async function getEmailAnalysis(userId: string): Promise<ConnectorResult> {
  const connected = await getConnectorStatus(userId);

  if (!connected.email) {
    return {
      ok: false,
      reason: missingConnectorPrompt('email'),
    };
  }

  const payload = await getConnectorCache(userId, 'email', 'inbox_digest');

  if (!payload) {
    return {
      ok: true,
      summary:
        'Email connector is active, but there is no readable inbox digest cached yet. Once readable connector payloads or webhook syncs are available, this will prioritize inbox load, urgency, and reply batching.',
      actions: [],
    };
  }

  const messages = Array.isArray(payload?.messages) ? payload.messages : [];

  const actions = messages.slice(0, 5).map((m: any) => {
    const subject = m?.subject || 'No subject';
    const priority = m?.priority ? ` (${m.priority})` : '';
    return `${subject}${priority}`;
  });

  const summary =
    `You have ${messages.length} cached email items. ` +
    `Top actionable threads: ${actions.join(', ') || 'none yet'}.`;

  return {
    ok: true,
    summary,
    actions,
  };
}

export async function getSocialConnectorSummary(userId: string): Promise<string> {
  const connected = await getConnectorStatus(userId);
  const parts: string[] = [];

  if (connected.instagram) {
    const instagramPayload = await getConnectorCache(userId, 'instagram', 'creator_summary');
    parts.push(
      instagramPayload
        ? 'Instagram connector active with cached creator summary.'
        : 'Instagram connector active but no cached data yet.'
    );
  } else {
    parts.push(missingConnectorPrompt('instagram'));
  }

  if (connected.facebook) {
    const facebookPayload = await getConnectorCache(userId, 'facebook', 'creator_summary');
    parts.push(
      facebookPayload
        ? 'Facebook connector active with cached page summary.'
        : 'Facebook connector active but no cached data yet.'
    );
  } else {
    parts.push(missingConnectorPrompt('facebook'));
  }

  if (connected.calendly) {
    const calendlyPayload = await getConnectorCache(userId, 'calendly', 'booking_summary');
    parts.push(
      calendlyPayload
        ? 'Calendly connector active with booking summary.'
        : 'Calendly connector active but no cached booking data yet.'
    );
  } else {
    parts.push(missingConnectorPrompt('calendly'));
  }

  return parts.join(' ');
}

export async function cacheConnectorPayload(
  userId: string,
  connectorKey: ConnectorKey,
  cacheKey: string,
  payload: any
) {
  await setConnectorCache(userId, connectorKey, cacheKey, payload);
}

function computeFocusWindows(events: any[]): string[] {
  const busyHours = new Set<number>();

  for (const event of events) {
    const start = event?.start ? new Date(event.start) : null;
    const end = event?.end ? new Date(event.end) : null;

    if (!start || !end || Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) {
      continue;
    }

    for (let h = start.getHours(); h <= end.getHours(); h++) {
      busyHours.add(h);
    }
  }

  const windows: string[] = [];

  for (let h = 8; h <= 18; h++) {
    if (!busyHours.has(h) && !busyHours.has(h + 1)) {
      windows.push(`${labelHour(h)}–${labelHour(h + 1)}`);
    }
  }

  return windows.slice(0, 3);
}

function buildCalendarSummary(events: any[], focusWindows: string[]): string {
  if (!events.length) {
    return 'Calendar is connected, but there are no cached upcoming events to analyze yet.';
  }

  const meetingCount = events.filter((e: any) =>
    /(meeting|call|sync|review)/i.test(e?.title || '')
  ).length;

  return `You have ${events.length} cached upcoming events, including ${meetingCount} likely meetings. Best open focus windows from cached data: ${focusWindows.join(', ') || 'none identified yet'}.`;
}

function labelHour(h: number): string {
  const hour = ((h + 11) % 12) + 1;
  const suffix = h < 12 ? 'AM' : 'PM';
  return `${hour} ${suffix}`;
}