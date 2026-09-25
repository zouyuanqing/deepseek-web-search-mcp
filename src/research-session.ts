import { randomUUID } from "node:crypto";
import type { ResearchResult, SearchSource } from "./types.js";
import { dedupeSources } from "./utils.js";

export interface ResearchSession {
  id: string;
  originalQuery: string;
  query: string;
  turn: number;
  maxTurns: number;
  createdAt: number;
  expiresAt: number;
  answerMarkdown: string;
  sources: SearchSource[];
  claims: string[];
  gaps: string[];
}

export class ResearchSessionStore {
  private readonly sessions = new Map<string, ResearchSession>();

  constructor(
    private readonly ttlMs: number,
    private readonly maxSessions: number,
  ) {}

  start(
    input: { query: string; maxTurns: number },
    result: ResearchResult,
  ): ResearchSession {
    this.prune();
    const now = Date.now();
    const session: ResearchSession = {
      id: randomUUID(),
      originalQuery: input.query,
      query: input.query,
      turn: 1,
      maxTurns: input.maxTurns,
      createdAt: now,
      expiresAt: now + this.ttlMs,
      answerMarkdown: result.answerMarkdown,
      sources: [...result.sources],
      claims: result.answerMarkdown.length > 0 ? [result.answerMarkdown] : [],
      gaps: [...result.warnings],
    };
    this.sessions.set(session.id, session);
    while (this.sessions.size > this.maxSessions) {
      const oldest = this.sessions.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.sessions.delete(oldest);
    }
    return session;
  }

  get(id: string): ResearchSession {
    this.prune();
    const session = this.sessions.get(id);
    if (session === undefined) throw new Error("Research session was not found or has expired.");
    return session;
  }

  append(
    session: ResearchSession,
    query: string,
    result: ResearchResult,
  ): ResearchSession {
    session.query = query;
    session.turn += 1;
    session.expiresAt = Date.now() + this.ttlMs;
    session.answerMarkdown = result.answerMarkdown;
    session.sources = dedupeSources([...session.sources, ...result.sources]);
    if (result.answerMarkdown.length > 0) session.claims.push(result.answerMarkdown);
    session.gaps = [...new Set([...session.gaps, ...result.warnings])];
    this.sessions.set(session.id, session);
    return session;
  }

  close(id: string): boolean {
    this.prune();
    return this.sessions.delete(id);
  }

  private prune(): void {
    const now = Date.now();
    for (const [id, session] of this.sessions) {
      if (session.expiresAt <= now) this.sessions.delete(id);
    }
  }
}
