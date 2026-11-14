// Main keeps the last known lists from agent events (for snapshot.json and for late renderer reloads).
import type {
  Chat,
  DoctorWarning,
  Hello,
  Project,
  Session,
  Snapshot,
  SystemStats,
  Usage,
} from '../shared/model';

export class DataCache {
  sessions: Session[] = [];
  chats = new Map<string, Chat>();
  projects: Project[] = [];
  system: SystemStats | null = null;
  doctor: DoctorWarning | null = null;
  usage: Usage | null = null;
  hello: Hello | null = null;

  load(s: Snapshot | null): void {
    if (!s) return;
    this.sessions = s.sessions ?? [];
    this.chats = new Map((s.chats ?? []).map((c) => [c.id, c]));
    this.projects = s.projects ?? [];
    this.system = s.system ?? null;
    this.doctor = s.doctor ?? null;
    this.usage = s.usage ?? null;
    this.hello = s.hello ?? null;
  }

  /** apply an agent event; returns true if lists changed */
  apply(event: string, data: unknown): boolean {
    switch (event) {
      case 'hello':
        this.hello = data as Hello;
        return true;
      case 'active_changed':
        this.sessions = (data as { sessions: Session[] }).sessions;
        return true;
      case 'chats_changed': {
        const d = data as { full?: Chat[]; upsert?: Chat[]; remove?: string[] };
        if (d.full) this.chats = new Map(d.full.map((c) => [c.id, c]));
        for (const c of d.upsert ?? []) this.chats.set(c.id, c);
        for (const id of d.remove ?? []) this.chats.delete(id);
        return true;
      }
      case 'projects_changed':
        this.projects = (data as { full: Project[] }).full;
        return true;
      case 'system':
        this.system = data as SystemStats;
        return true;
      case 'doctor_warning':
        this.doctor = data as DoctorWarning;
        return true;
      default:
        return false;
    }
  }

  toSnapshot(): Snapshot {
    return {
      at: Date.now(),
      sessions: this.sessions,
      chats: [...this.chats.values()],
      projects: this.projects,
      system: this.system,
      doctor: this.doctor,
      usage: this.usage,
      hello: this.hello,
    };
  }
}
