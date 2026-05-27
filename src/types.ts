export type Energy = 'low' | 'medium' | 'high' | null;
export type Mood = 'focused' | 'neutral' | 'overwhelmed' | 'scattered' | 'energized' | null;

export type Scene =
  | 'desk_working'
  | 'desk_idle'
  | 'meeting_room'
  | 'eating'
  | 'away_from_desk'
  | 'phone_scrolling'
  | 'resting'
  | 'exercise'
  | 'unknown';

export type Intent =
  | 'START'
  | 'END'
  | 'ENERGY'
  | 'BREAK_QUERY'
  | 'NEXT_TASK'
  | 'SUMMARY'
  | 'CALENDAR_BLOCK'
  | 'EMAIL_SUMMARY'
  | 'OVERWHELM'
  | 'UNKNOWN';

export type ConnectorKey = 'calendar' | 'email' | 'instagram' | 'calendly' | 'facebook';

export interface ParsedIntent {
  intent: Intent;
  energy?: Energy;
  taskLabel?: string;
}

export interface VisualSignal {
  scene: Scene;
  confidence: number;
  notes: string;
  observedAt?: string;
}

export interface TruthAssessment {
  softChallenge?: string;
  inferredStatus?: 'working' | 'break' | 'meeting' | 'idle';
}

export interface ConnectorStatusMap {
  calendar: boolean;
  email: boolean;
  instagram: boolean;
  calendly: boolean;
  facebook: boolean;
}

export interface UserStateRow {
  user_id: string;
  timezone: string | null;
  current_status: string | null;
  current_energy: Energy;
  current_mood: Mood;
  current_task: string | null;
  current_session_id: string | null;
  updated_at: string;
}

export interface SessionRow {
  id: string;
  user_id: string;
  task_label: string | null;
  status: string;
  started_at: string;
  ended_at: string | null;
  duration_min: number | null;
}