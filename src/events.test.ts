import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import request from "supertest";
import { EventLog, parseEvent } from "./events.js";
import { createApp } from "./app.js";

const ID = "art-0123456789abcdef";
const ID2 = "art-fedcba9876543210";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "events-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("parseEvent", () => {
  it("keeps a well-formed event and stamps it", () => {
    const now = new Date("2026-09-23T07:30:00.000Z");
    expect(parseEvent({ kind: "open", id: ID, category: "Sport", topic: "F1" }, now)).toEqual({
      t: "2026-09-23T07:30:00.000Z",
      kind: "open",
      id: ID,
      category: "Sport",
      topic: "F1",
    });
  });

  it("drops labels that are missing or empty rather than storing blanks", () => {
    const e = parseEvent({ kind: "open", id: ID, category: "", topic: undefined });
    expect(e).not.toBeNull();
    expect(e).not.toHaveProperty("category");
    expect(e).not.toHaveProperty("topic");
  });

  it.each([
    ["an unknown kind", { kind: "scrolled", id: ID }],
    ["no kind", { id: ID }],
    ["an id that is not an article id", { kind: "open", id: "../../etc/passwd" }],
    ["an id of the wrong length", { kind: "open", id: "art-0123" }],
    ["no id", { kind: "open" }],
    ["a non-object", "open"],
    ["null", null],
  ])("refuses %s", (_name, body) => {
    expect(parseEvent(body)).toBeNull();
  });

  it("refuses a label longer than the cap instead of storing it", () => {
    const e = parseEvent({ kind: "open", id: ID, category: "x".repeat(81) });
    expect(e).not.toHaveProperty("category");
  });
});

describe("EventLog", () => {
  it("reads back nothing when the log has never been written", async () => {
    expect(await new EventLog(dir).read()).toEqual([]);
    expect(await new EventLog(dir).summary()).toMatchObject({ events: 0, first: null, last: null });
  });

  it("appends in order and survives a reopen", async () => {
    const log = new EventLog(dir);
    await log.append(parseEvent({ kind: "open", id: ID }, new Date("2026-09-23T07:00:00Z"))!);
    await log.append(parseEvent({ kind: "open", id: ID2 }, new Date("2026-09-23T08:00:00Z"))!);
    const fresh = await new EventLog(dir).read();
    expect(fresh.map((e) => e.id)).toEqual([ID, ID2]);
  });

  it("drops a truncated final line and keeps the rest", async () => {
    const log = new EventLog(dir);
    await log.append(parseEvent({ kind: "open", id: ID }, new Date())!);
    await writeFile(log.path, (await readFile(log.path, "utf8")) + '{"t":"2026', "utf8");
    const back = await log.read();
    expect(back).toHaveLength(1);
    expect(back[0].id).toBe(ID);
  });

  it("counts by kind, category and topic and reports the window", async () => {
    const log = new EventLog(dir);
    await log.append(parseEvent({ kind: "open", id: ID, category: "Sport", topic: "F1" }, new Date("2026-09-23T07:00:00Z"))!);
    await log.append(parseEvent({ kind: "open", id: ID2, category: "Sport", topic: "Golf" }, new Date("2026-09-23T07:30:00Z"))!);
    await log.append(parseEvent({ kind: "full-text", id: ID, category: "Tech" }, new Date("2026-09-23T08:00:00Z"))!);
    expect(await log.summary()).toEqual({
      events: 3,
      byKind: { open: 2, "full-text": 1 },
      byCategory: { Sport: 2, Tech: 1 },
      byTopic: { F1: 1, Golf: 1 },
      shownByCategory: {},
      shownByTopic: {},
      first: "2026-09-23T07:00:00.000Z",
      last: "2026-09-23T08:00:00.000Z",
    });
  });
});

describe("the events routes", () => {
  const app = () => createApp("http://newspaper.invalid", (async () => {
    throw new Error("the events routes must not call the newspaper");
  }) as unknown as typeof fetch, dir);

  it("records an open and shows it in the summary", async () => {
    await request(app()).post("/api/events").send({ kind: "open", id: ID, category: "Sport" }).expect(204);
    const { body } = await request(app()).get("/api/events/summary").expect(200);
    expect(body).toMatchObject({ events: 1, byKind: { open: 1 }, byCategory: { Sport: 1 } });
  });

  it("refuses a bad event with 400 and writes nothing", async () => {
    await request(app()).post("/api/events").send({ kind: "open", id: "nope" }).expect(400);
    const { body } = await request(app()).get("/api/events/summary").expect(200);
    expect(body.events).toBe(0);
  });

  it("answers the summary before anything has been read", async () => {
    const { body } = await request(app()).get("/api/events/summary").expect(200);
    expect(body).toMatchObject({ events: 0, byKind: {}, first: null, last: null });
  });

  // A full front page with the longest labels the parser accepts. The route
  // used to cap bodies at 8kb, which this exceeds -- and the client swallows
  // the error, so the cap failing here would lose every impression in silence.
  // The live page is 237 stories and 26kb; this is the worst the parser stores.
  it("accepts a full page at the longest labels it will store", async () => {
    const items = Array.from({ length: 300 }, (_, i) => ({
      id: "art-" + i.toString(16).padStart(16, "0"),
      category: "c".repeat(80),
      topic: "t".repeat(80),
    }));
    expect(JSON.stringify({ kind: "front-page", items }).length).toBeGreaterThan(26 * 1024);
    await request(app()).post("/api/events").send({ kind: "front-page", items }).expect(204);
    const { body } = await request(app()).get("/api/events/summary").expect(200);
    expect(body.shownByTopic["t".repeat(80)]).toBe(300);
  });
});

describe("front-page impressions", () => {
  const item = (id: string, topic?: string) => ({ id, category: "Sport", topic });
  const A = "art-" + "a".repeat(16);
  const B = "art-" + "b".repeat(16);

  it("stores what was on screen, with no article id of its own", () => {
    const e = parseEvent({ kind: "front-page", items: [item(A, "Cycling"), item(B)] });
    expect(e).toEqual({
      t: expect.any(String),
      kind: "front-page",
      items: [
        { id: A, category: "Sport", topic: "Cycling" },
        { id: B, category: "Sport" },
      ],
    });
    expect(e).not.toHaveProperty("id");
  });

  it("refuses a front page with nothing on it", () => {
    expect(parseEvent({ kind: "front-page", items: [] })).toBeNull();
    expect(parseEvent({ kind: "front-page", items: [{ id: "nope" }] })).toBeNull();
    expect(parseEvent({ kind: "front-page" })).toBeNull();
  });

  it("drops a bad item rather than the whole screenful", () => {
    const e = parseEvent({ kind: "front-page", items: [{ id: "nope" }, item(A)] });
    expect(e!.items).toEqual([{ id: A, category: "Sport" }]);
  });

  it("truncates rather than refusing an oversized screenful", () => {
    const many = Array.from({ length: 400 }, (_, i) =>
      item("art-" + i.toString(16).padStart(16, "0")),
    );
    const e = parseEvent({ kind: "front-page", items: many });
    expect(e!.items).toHaveLength(300);
    expect(e!.items![0].id).toBe(many[0].id);
  });

  it("still requires an article id on an open", () => {
    expect(parseEvent({ kind: "open", items: [item(A)] })).toBeNull();
  });

  it("summarises impressions separately from opens, so a rate can be taken", async () => {
    const dir = await mkdtemp(join(tmpdir(), "post-shown-"));
    const log = new EventLog(dir);
    await log.append(parseEvent({ kind: "front-page", items: [item(A, "Cycling"), item(B, "Golf")] })!);
    await log.append(parseEvent({ kind: "front-page", items: [item(A, "Cycling")] })!);
    await log.append(parseEvent({ kind: "open", id: A, category: "Sport", topic: "Cycling" })!);
    const s = await log.summary();
    expect(s.shownByTopic).toEqual({ Cycling: 2, Golf: 1 });
    expect(s.shownByCategory).toEqual({ Sport: 3 });
    expect(s.byTopic).toEqual({ Cycling: 1 });
    expect(s.byKind).toEqual({ "front-page": 2, open: 1 });
  });
});
