// The reading log: what he actually opened, appended to disk as it happens.
//
// M2's taste model needs a per-topic signal and there is almost none today --
// of the 2,288 articles in the newspaper's store, 62 carry a thumb (2.7%) and
// nothing anywhere records an open. Votes are a thing he has to remember to
// do; opening a story is the thing he already does. So this records the
// second one, and the model in the next milestone reads it.
//
// Append-only JSONL rather than a table, because the interesting question
// later is "what changed over time" and a log answers that while a counter
// does not. The volume is already provisioned: DATA_DIR is mounted from the
// sokrates-post-data PVC and, until now, nothing in this app read it.

import { appendFile, readFile } from "node:fs/promises";
import { join } from "node:path";

// Only kinds something actually emits. A kind nobody sends is a column of
// zeroes that later looks like a signal.
export const KINDS = ["open", "full-text"] as const;
export type Kind = (typeof KINDS)[number];

export interface ReadEvent {
  t: string;
  kind: Kind;
  id: string;
  category?: string;
  topic?: string;
}

export interface Summary {
  events: number;
  byKind: Record<string, number>;
  byCategory: Record<string, number>;
  byTopic: Record<string, number>;
  first: string | null;
  last: string | null;
}

// The newspaper's own id shape, same as app.ts refuses on.
const ARTICLE_ID = /^art-[0-9a-f]{16}$/;
const LABEL_MAX = 80;

const label = (v: unknown) =>
  typeof v === "string" && v.length > 0 && v.length <= LABEL_MAX ? v : undefined;

/** Returns the event to log, or null if the client sent something we will not store. */
export function parseEvent(body: unknown, now = new Date()): ReadEvent | null {
  if (!body || typeof body !== "object") return null;
  const b = body as Record<string, unknown>;
  if (!KINDS.includes(b.kind as Kind)) return null;
  if (typeof b.id !== "string" || !ARTICLE_ID.test(b.id)) return null;
  const e: ReadEvent = { t: now.toISOString(), kind: b.kind as Kind, id: b.id };
  const category = label(b.category);
  const topic = label(b.topic);
  if (category) e.category = category;
  if (topic) e.topic = topic;
  return e;
}

export class EventLog {
  readonly path: string;

  constructor(dataDir: string) {
    this.path = join(dataDir, "events.jsonl");
  }

  async append(e: ReadEvent): Promise<void> {
    await appendFile(this.path, JSON.stringify(e) + "\n", "utf8");
  }

  /** Every event on disk. A truncated last line (a kill mid-append) is dropped, not thrown. */
  async read(): Promise<ReadEvent[]> {
    let raw: string;
    try {
      raw = await readFile(this.path, "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw err;
    }
    const out: ReadEvent[] = [];
    for (const line of raw.split("\n")) {
      if (!line) continue;
      try {
        out.push(JSON.parse(line) as ReadEvent);
      } catch {
        // A half-written final line. Skip it; the rest of the log is intact.
      }
    }
    return out;
  }

  async summary(): Promise<Summary> {
    const events = await this.read();
    const s: Summary = {
      events: events.length,
      byKind: {},
      byCategory: {},
      byTopic: {},
      first: events[0]?.t ?? null,
      last: events[events.length - 1]?.t ?? null,
    };
    for (const e of events) {
      s.byKind[e.kind] = (s.byKind[e.kind] || 0) + 1;
      if (e.category) s.byCategory[e.category] = (s.byCategory[e.category] || 0) + 1;
      if (e.topic) s.byTopic[e.topic] = (s.byTopic[e.topic] || 0) + 1;
    }
    return s;
  }
}
