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
//
// `front-page` was added after four days live produced one event, and that one
// was a cycle's probe. Both original kinds require opening a story, which is
// the thing Edvard almost never does -- he reads the front page and stops. So
// the log recorded the rare behaviour and nothing at all about the common one,
// and it could not even tell "he never opens stories" apart from "he has never
// opened this app". It carries the stories that were on screen, because opens
// counted without impressions measure what the paper publishes most, not what
// he likes: a topic printed 40 times and opened twice outranks one printed
// twice and opened twice. The ratio is the signal; this is its denominator.
export const KINDS = ["open", "full-text", "front-page"] as const;
export type Kind = (typeof KINDS)[number];

/** One story that was on screen. Same fields an `open` carries, so the two sides divide. */
export interface Impression {
  id: string;
  category?: string;
  topic?: string;
}

export interface ReadEvent {
  t: string;
  kind: Kind;
  /** The story. Absent on `front-page`, which is about a screenful rather than one story. */
  id?: string;
  category?: string;
  topic?: string;
  /** What was on screen. Only on `front-page`. */
  items?: Impression[];
}

export interface Summary {
  events: number;
  byKind: Record<string, number>;
  byCategory: Record<string, number>;
  byTopic: Record<string, number>;
  /** Impressions, from `front-page` events -- the denominator for byCategory/byTopic. */
  shownByCategory: Record<string, number>;
  shownByTopic: Record<string, number>;
  first: string | null;
  last: string | null;
}

// The newspaper's own id shape, same as app.ts refuses on.
const ARTICLE_ID = /^art-[0-9a-f]{16}$/;
const LABEL_MAX = 80;
// The front page renders a lead, ~10 stories and ~20 briefs. 60 is well clear
// of that and still bounds the body: the request is TRUNCATED to it rather
// than refused, because the client fires and forgets and swallows a 400, so a
// refusal here would be a month of silence rather than an error anybody sees.
const ITEMS_MAX = 60;

const label = (v: unknown) =>
  typeof v === "string" && v.length > 0 && v.length <= LABEL_MAX ? v : undefined;

function parseImpressions(v: unknown): Impression[] | null {
  if (!Array.isArray(v)) return null;
  const out: Impression[] = [];
  for (const raw of v.slice(0, ITEMS_MAX)) {
    if (!raw || typeof raw !== "object") continue;
    const r = raw as Record<string, unknown>;
    if (typeof r.id !== "string" || !ARTICLE_ID.test(r.id)) continue;
    const item: Impression = { id: r.id };
    const category = label(r.category);
    const topic = label(r.topic);
    if (category) item.category = category;
    if (topic) item.topic = topic;
    out.push(item);
  }
  // A front page with nothing on it is not an impression of anything.
  return out.length ? out : null;
}

/** Returns the event to log, or null if the client sent something we will not store. */
export function parseEvent(body: unknown, now = new Date()): ReadEvent | null {
  if (!body || typeof body !== "object") return null;
  const b = body as Record<string, unknown>;
  if (!KINDS.includes(b.kind as Kind)) return null;
  if (b.kind === "front-page") {
    const items = parseImpressions(b.items);
    if (!items) return null;
    return { t: now.toISOString(), kind: "front-page", items };
  }
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
      shownByCategory: {},
      shownByTopic: {},
      first: events[0]?.t ?? null,
      last: events[events.length - 1]?.t ?? null,
    };
    for (const e of events) {
      s.byKind[e.kind] = (s.byKind[e.kind] || 0) + 1;
      if (e.category) s.byCategory[e.category] = (s.byCategory[e.category] || 0) + 1;
      if (e.topic) s.byTopic[e.topic] = (s.byTopic[e.topic] || 0) + 1;
      for (const i of e.items || []) {
        if (i.category) s.shownByCategory[i.category] = (s.shownByCategory[i.category] || 0) + 1;
        if (i.topic) s.shownByTopic[i.topic] = (s.shownByTopic[i.topic] || 0) + 1;
      }
    }
    return s;
  }
}
