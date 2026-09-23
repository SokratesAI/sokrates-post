import { describe, expect, it } from "vitest";
import { buildTaste, PRIOR_IMPRESSIONS, TASTE_WEIGHT } from "./taste.js";
import { buildFrontPage, type Article, type Config } from "./frontPage.js";
import type { Summary } from "./events.js";

function summary(p: Partial<Summary>): Summary {
  return {
    events: 0,
    byKind: {},
    byCategory: {},
    byTopic: {},
    shownByCategory: {},
    shownByTopic: {},
    first: null,
    last: null,
    ...p,
  };
}

/** Impressions well past the smoothing prior, so a rate is allowed to move. */
const LOTS = PRIOR_IMPRESSIONS * 8;

describe("buildTaste", () => {
  it("is neutral with no summary at all", () => {
    const t = buildTaste(null);
    expect(t.informed).toBe(false);
    expect(t.lift({ topic: "anything", category: "anything" })).toBe(0);
  });

  it("is neutral on the log as it stands live, probe row and all", () => {
    // The exact shape of `GET /api/events/summary` on 2026-09-23 16:05 Oslo:
    // one probe `open` under a category no front page has ever carried, and
    // one headless front-page load. The earlier version of this test left the
    // probe out and passed for the wrong reason -- a positive guaranteed in
    // advance -- while the live log made the model think it had learned
    // something and quietly demote every category that was really on screen.
    const t = buildTaste(
      summary({
        events: 2,
        byKind: { open: 1, "front-page": 1 },
        byCategory: { Probe: 1 },
        shownByTopic: { RSS: 90, "Breaking news": 5, "World news today": 5 },
        shownByCategory: { World: 95, Technology: 5 },
      }),
    );
    expect(t.informed).toBe(false);
    expect(t.lift({ topic: "RSS" })).toBe(0);
    expect(t.lift({ topic: "Breaking news", category: "World" })).toBe(0);
    expect(t.lift({ category: "Technology" })).toBe(0);
    expect(t.lift({ category: "Probe" })).toBe(0);
  });

  it("ignores an open on something no front page ever carried", () => {
    // Same failure one step on: a real signal exists, and a junk row must not
    // dilute the baseline every real topic is measured against.
    const withJunk = buildTaste(
      summary({
        byTopic: { Chess: 40, Ghost: 99 },
        shownByTopic: { Chess: LOTS, Football: LOTS },
      }),
    );
    const without = buildTaste(
      summary({ byTopic: { Chess: 40 }, shownByTopic: { Chess: LOTS, Football: LOTS } }),
    );
    expect(withJunk.lift({ topic: "Chess" })).toBe(without.lift({ topic: "Chess" }));
    expect(withJunk.baseline).toBe(without.baseline);
  });

  it("is neutral when opens exist but nothing was ever recorded as shown", () => {
    const t = buildTaste(summary({ byTopic: { Chess: 4 } }));
    expect(t.informed).toBe(false);
    expect(t.lift({ topic: "Chess" })).toBe(0);
  });

  it("lifts a topic he opens more often than the paper average", () => {
    const t = buildTaste(
      summary({
        byTopic: { Chess: 40, Football: 0 },
        shownByTopic: { Chess: LOTS, Football: LOTS },
      }),
    );
    expect(t.informed).toBe(true);
    expect(t.lift({ topic: "Chess" })).toBeGreaterThan(0);
    expect(t.lift({ topic: "Football" })).toBeLessThan(0);
  });

  it("trusts a rate less when there is less behind it", () => {
    // Both topics were opened every single time they were printed. `Fluke` was
    // printed twice, `Proven` two hundred times. Raw rates cannot tell them
    // apart -- both are 1.0 -- and smoothing is the only thing that does.
    const t = buildTaste(
      summary({
        byTopic: { Fluke: 2, Proven: LOTS, Ignored: 0 },
        shownByTopic: { Fluke: 2, Proven: LOTS, Ignored: LOTS },
      }),
    );
    expect(t.lift({ topic: "Proven" })).toBeGreaterThan(t.lift({ topic: "Fluke" }));
    expect(t.lift({ topic: "Fluke" })).toBeGreaterThan(t.lift({ topic: "Ignored" }));
  });

  it("never moves a story further than TASTE_WEIGHT either way", () => {
    // `Loved` is opened every time against a baseline of 9%, so its relative
    // rate is nearly ten times the average -- without a ceiling that alone
    // would outweigh every other term in the editor's score put together.
    const t = buildTaste(
      summary({
        byTopic: { Loved: LOTS, Ignored: 0 },
        shownByTopic: { Loved: LOTS, Ignored: LOTS * 10 },
      }),
    );
    expect(t.lift({ topic: "Loved" })).toBe(TASTE_WEIGHT);
    expect(t.lift({ topic: "Ignored" })).toBeGreaterThanOrEqual(-TASTE_WEIGHT);
  });

  it("falls back to the category when the topic has never been printed", () => {
    const t = buildTaste(
      summary({
        byCategory: { Sport: 40 },
        shownByCategory: { Sport: LOTS, Finance: LOTS },
        byTopic: { Chess: 1 },
        shownByTopic: { Chess: LOTS },
      }),
    );
    expect(t.lift({ topic: "brand new topic", category: "Sport" })).toBeGreaterThan(0);
    expect(t.lift({ topic: "brand new topic", category: "Finance" })).toBeLessThan(0);
  });

  it("says nothing about an article whose topic and category are both unseen", () => {
    const t = buildTaste(
      summary({ byTopic: { Chess: 40 }, shownByTopic: { Chess: LOTS } }),
    );
    expect(t.lift({ topic: "unseen", category: "unseen" })).toBe(0);
    expect(t.lift({})).toBe(0);
  });
});

describe("the front page under the taste model", () => {
  const day = "2026-09-23";
  const article = (id: string, category: string, topic: string): Article => ({
    _id: id,
    category,
    topic,
    title_en: id,
    date: day,
    generated_at: `${day}T06:00:00`,
  });
  // One story per section, so the two-per-section cap cannot be what reorders them.
  const articles: Article[] = [
    article("art-00000000000000a1", "Football", "Football"),
    article("art-00000000000000a2", "Chess", "Chess"),
  ];
  const config: Config = {};
  const now = new Date(`${day}T08:00:00Z`).getTime();
  /** A log in which one topic is opened every time and the other never is. */
  const loves = (topic: string) =>
    buildTaste(
      summary({
        byTopic: { [topic]: LOTS },
        shownByTopic: { Football: LOTS, Chess: LOTS },
      }),
    );

  it("ranks exactly as it did before the model existed, on an empty log", () => {
    const before = buildFrontPage(articles, config, now);
    const after = buildFrontPage(articles, config, now, buildTaste(summary({})));
    expect(after).toEqual(before);
    expect(after.lead?._id).toBe("art-00000000000000a1");
  });

  it("promotes the topic he reads over the one he skips", () => {
    const t = buildTaste(
      summary({
        byTopic: { Chess: 40, Football: 0 },
        shownByTopic: { Chess: LOTS, Football: LOTS },
      }),
    );
    const page = buildFrontPage(articles, config, now, t);
    expect(page.lead?._id).toBe("art-00000000000000a2");
  });

  it("never outranks the category dial he set by hand", () => {
    const t = loves("Chess");
    const boosted: Article[] = [{ ...articles[0], category: "Boosted" }, articles[1]];
    const page = buildFrontPage(boosted, { categories: { Boosted: { boost: 1 } } }, now, t);
    expect(page.lead?._id).toBe("art-00000000000000a1");
  });

  it("never outranks a run of thumbs he gave by hand", () => {
    // Thumbs count per category, and the editor caps their pull at 3. These
    // three are yesterday's paper, off the page but still in the store, which
    // is where a category's standing vote actually lives.
    const t = loves("Chess");
    const older = ["b1", "b2", "b3"].map((n) => ({
      ...article(`art-00000000000000${n}`, "Football", "Football"),
      date: "2026-09-01",
      generated_at: "2026-09-01T06:00:00",
      feedback: "up" as const,
    }));
    const page = buildFrontPage([...articles, ...older], config, now, t);
    expect(page.lead?._id).toBe("art-00000000000000a1");
  });

  it("cannot put back a story he thumbed down", () => {
    const t = loves("Chess");
    const down: Article[] = [articles[0], { ...articles[1], feedback: "down" }];
    const page = buildFrontPage(down, config, now, t);
    expect([page.lead, ...page.stories].map((a) => a?._id)).not.toContain("art-00000000000000a2");
  });

  it("cannot unmute a category he muted", () => {
    const t = loves("Chess");
    const page = buildFrontPage(articles, { categories: { Chess: { muted: true } } }, now, t);
    expect([page.lead, ...page.stories, ...page.briefs].map((a) => a?._id)).not.toContain(
      "art-00000000000000a2",
    );
  });
});
