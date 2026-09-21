import { describe, it, expect } from "vitest";
import request from "supertest";
import { buildFrontPage, type Article } from "./frontPage.js";
import { createApp } from "./app.js";

const NOW = Date.parse("2026-09-21T19:00:00Z");
const art = (id: string, category = "General", over: Partial<Article> = {}): Article => ({
  _id: id,
  category,
  image_url: `${id}.jpg`,
  has_full_text: true,
  generated_at: "2026-09-21T10:00:00Z",
  ...over,
});
const ids = (xs: Article[]) => xs.map((a) => a._id);

describe("buildFrontPage", () => {
  it("keeps every story in the window on the page exactly once", () => {
    const page = Array.from({ length: 40 }, (_, i) => art(`a${i}`, `C${i % 7}`));
    const r = buildFrontPage(page, {}, NOW);
    const all = [r.lead!._id, ...ids(r.stories), ...ids(r.briefs)];
    expect(all.sort()).toEqual(ids(page).sort());
    expect(r.stories).toHaveLength(8);
    expect(r.briefs).toHaveLength(31);
  });

  it("gives no section more than two top slots", () => {
    const page = Array.from({ length: 20 }, (_, i) => art(`s${i}`, "Space"));
    const r = buildFrontPage([...page, art("b", "Books")], { categories: { Space: { boost: 1 } } }, NOW);
    const top = [r.lead!, ...r.stories];
    expect(top.filter((a) => a.category === "Space")).toHaveLength(2);
  });

  it("leads with a boosted section and never tops a story he voted down", () => {
    const r = buildFrontPage(
      [art("plain", "Books"), art("boosted", "Space"), art("down", "Space", { feedback: "down" })],
      { categories: { Space: { boost: 1 } } },
      NOW,
    );
    expect(r.lead!._id).toBe("boosted");
    expect(ids(r.briefs)).toContain("down");
  });

  it("scores a shared site-default image as no picture", () => {
    const stock = { image_url: "logo.png" };
    const r = buildFrontPage(
      [
        art("logo1", "A", { ...stock, source_url: "u1" }),
        art("logo2", "B", { ...stock, source_url: "u2" }),
        art("logo3", "C", { ...stock, source_url: "u3" }),
        art("own", "D"),
      ],
      {},
      NOW,
    );
    expect(r.lead!._id).toBe("own");
  });

  it("drops muted, dismissed and out-of-window stories, and falls back to the newest day", () => {
    const r = buildFrontPage(
      [
        art("muted", "Books"),
        art("gone", "A", { dismissed: true }),
        art("old", "A", { generated_at: "2026-09-19T10:00:00Z" }),
        art("fresh", "A"),
      ],
      { categories: { Books: { muted: true } } },
      NOW,
    );
    expect([r.lead!._id, ...ids(r.stories), ...ids(r.briefs)]).toEqual(["fresh"]);
    const stale = buildFrontPage(
      [art("d1", "A", { generated_at: undefined, date: "2026-09-10" }), art("d0", "A", { generated_at: undefined, date: "2026-09-09" })],
      {},
      NOW,
    );
    expect(stale.lead!._id).toBe("d1");
    expect(stale.briefs).toHaveLength(0);
  });
});

describe("GET /api/front-page", () => {
  const stub = (articles: unknown, status = 200): typeof fetch =>
    (async (url: string) =>
      new Response(JSON.stringify(String(url).endsWith("/api/config") ? { config: {} } : articles), {
        status,
      })) as unknown as typeof fetch;

  it("edits the live paper it reads", async () => {
    const app = createApp("http://paper", stub({ articles: [art("x", "A", { generated_at: new Date().toISOString() })], quote: "q" }));
    const res = await request(app).get("/api/front-page");
    expect(res.status).toBe(200);
    expect(res.body.lead._id).toBe("x");
    expect(res.body.quote).toBe("q");
  });

  it("says so when the paper does not answer", async () => {
    const res = await request(createApp("http://paper", stub({}, 503))).get("/api/front-page");
    expect(res.status).toBe(502);
  });
});
