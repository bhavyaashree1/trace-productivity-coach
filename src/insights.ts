import { Energy } from './types';
import { getRecentEnergy, getRecentSessions } from './db';

export async function buildPatternSummary(userId: string) {
  const sessions = await getRecentSessions(userId, 60);
  const energy = await getRecentEnergy(userId, 40);

  if (!sessions.length) {
    return 'I do not have enough session history yet. Keep logging work sessions and energy check-ins so I can identify your real productivity patterns.';
  }

  const avgDuration = Math.round(
    sessions.reduce((sum: number, s: any) => sum + (s.duration_min || 0), 0) / Math.max(1, sessions.length)
  );

  const categoryCounts: Record<string, number> = {};
  const hourCounts: Record<number, number> = {};
  for (const s of sessions) {
    const label = normaliseLabel(s.task_label || 'general work');
    categoryCounts[label] = (categoryCounts[label] || 0) + 1;
    const d = new Date(s.started_at);
    hourCounts[d.getHours()] = (hourCounts[d.getHours()] || 0) + 1;
  }

  const topCategory = Object.entries(categoryCounts).sort((a, b) => b[1] - a[1])[0]?.[0] || 'general work';
  const bestHour = Number(Object.entries(hourCounts).sort((a, b) => Number(b[1]) - Number(a[1]))[0]?.[0] || 10);

  const energySummary = summarizeEnergy(energy.map((e: any) => e.energy_level));
  const circadian = classifyCircadian(bestHour);

  return `From your recent history, your average completed session is about ${avgDuration} minutes. Your most common work pattern is ${topCategory}. Your strongest work window appears around ${labelHour(bestHour)}, which suggests a ${circadian} rhythm. Your energy pattern lately looks ${energySummary}.`;
}

export async function buildNextTaskRecommendation(userId: string, currentEnergy: Energy | null) {
  const sessions = await getRecentSessions(userId, 40);
  if (!sessions.length) {
    return baseEnergyRecommendation(currentEnergy);
  }

  const byEnergyAndLabel: Record<string, number> = {};
  for (const s of sessions) {
    const label = normaliseLabel(s.task_label || 'general work');
    byEnergyAndLabel[label] = (byEnergyAndLabel[label] || 0) + 1;
  }

  const top = Object.entries(byEnergyAndLabel).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([k]) => k);
  return `${baseEnergyRecommendation(currentEnergy)} Based on your recent patterns, the work types you return to most often are ${top.join(', ')}.`;
}

function summarizeEnergy(levels: string[]) {
  if (!levels.length) return 'untracked';
  const counts = { low: 0, medium: 0, high: 0 };
  for (const l of levels) {
    if (l === 'low') counts.low += 1;
    if (l === 'medium') counts.medium += 1;
    if (l === 'high') counts.high += 1;
  }
  if (counts.high >= counts.medium && counts.high >= counts.low) return 'strongest in high-energy windows';
  if (counts.medium >= counts.low) return 'more stable in medium-energy windows';
  return 'skewed toward lower-energy recovery windows';
}

function classifyCircadian(bestHour: number) {
  if (bestHour < 10) return 'morning-forward';
  if (bestHour < 14) return 'midday-peak';
  return 'later-day';
}

function baseEnergyRecommendation(energy: Energy | null) {
  if (energy === 'high') return 'Your current energy is high, so this is the right time for deep work, strategy, coding, or hard writing.';
  if (energy === 'medium') return 'Your current energy is medium, so planning, drafting, calls, and structured progress work are the best fit.';
  if (energy === 'low') return 'Your current energy is low, so choose admin, inbox cleanup, review work, or a short reset before restarting.';
  return 'Tell me your energy level and I will match the next task to your state.';
}

function normaliseLabel(label: string) {
  const l = label.toLowerCase();
  if (/deck|slide|presentation|investor/.test(l)) return 'presentation work';
  if (/email|inbox|follow up|follow-up/.test(l)) return 'email and admin';
  if (/meeting|call|sync/.test(l)) return 'meetings and calls';
  if (/write|draft|copy|doc/.test(l)) return 'writing';
  if (/research|strategy|plan|planning/.test(l)) return 'strategy and planning';
  return 'general work';
}

function labelHour(h: number) {
  const hour = ((h + 11) % 12) + 1;
  const suffix = h < 12 ? 'AM' : 'PM';
  return `${hour} ${suffix}`;
}