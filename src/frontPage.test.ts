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

describe("the page", () => {
  it("serves the front page shell, its script and the vendored Preact", async () => {
    const app = createApp("http://paper");
    const index = await request(app).get("/");
    expect(index.status).toBe(200);
    expect(index.text).toContain('src="/app.js"');
    const js = (await request(app).get("/app.js")).text;
    expect(js).toContain("/api/front-page");
    expect(js).toContain("/api/full-text/");
    expect((await request(app).get("/vendor/preact-htm.js")).text).toContain("htmPreact");
  });
});

describe("the article view's routes", () => {
  const ID = "art-0123456789abcdef";
  const seen: string[] = [];
  const paper = (async (url: string) => {
    seen.push(String(url));
    if (String(url).endsWith("/api/articles")) return new Response(JSON.stringify({ articles: [art(ID, "Space")] }));
    if (String(url).endsWith(`/api/full-text/${ID}`)) return new Response(JSON.stringify({ full_text_en: "one\n\ntwo" }));
    return new Response(JSON.stringify({ error: "not found" }), { status: 404 });
  }) as unknown as typeof fetch;

  it("finds one story in the live paper", async () => {
    const res = await request(createApp("http://paper", paper)).get(`/api/article/${ID}`);
    expect(res.status).toBe(200);
    expect(res.body.category).toBe("Space");
    const missing = await request(createApp("http://paper", paper)).get("/api/article/art-ffffffffffffffff");
    expect(missing.status).toBe(404);
  });

  it("passes the full text through from the paper, status and all", async () => {
    const app = createApp("http://paper", paper);
    const res = await request(app).get(`/api/full-text/${ID}`);
    expect(res.status).toBe(200);
    expect(res.body.full_text_en).toBe("one\n\ntwo");
    expect(seen).toContain(`http://paper/api/full-text/${ID}`);
    expect((await request(app).get("/api/full-text/art-ffffffffffffffff")).status).toBe(404);
  });

  it("refuses anything that is not an article id before it reaches the paper", async () => {
    seen.length = 0;
    const app = createApp("http://paper", paper);
    for (const bad of ["x", "art-XYZ", "..%2Fconfig", "art-0123456789abcdef0"]) {
      expect((await request(app).get(`/api/full-text/${bad}`)).status).toBe(400);
      expect((await request(app).get(`/api/article/${bad}`)).status).toBe(400);
    }
    expect(seen).toEqual([]);
  });

  it("says so when the paper does not answer", async () => {
    const down = (async () => {
      throw new Error("ECONNREFUSED");
    }) as unknown as typeof fetch;
    expect((await request(createApp("http://paper", down)).get(`/api/full-text/${ID}`)).status).toBe(502);
    expect((await request(createApp("http://paper", down)).get(`/api/article/${ID}`)).status).toBe(502);
  });
});
