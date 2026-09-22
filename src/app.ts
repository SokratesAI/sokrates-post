import express from "express";
import { fileURLToPath } from "node:url";
import { buildFrontPage, type Article, type Config } from "./frontPage.js";

// The live paper is still written and served by the old `newspaper` app; the
// new one reads it over the cluster network until M5 moves the data across.
const PUBLIC_DIR = fileURLToPath(new URL("../public", import.meta.url));
// The newspaper's own id shape (ARTICLE_ID_PATTERN in its server.py); anything
// else is refused here rather than forwarded into its URL space.
const ARTICLE_ID = /^art-[0-9a-f]{16}$/;

export function createApp(newspaperUrl: string, fetchImpl: typeof fetch = fetch) {
  const app = express();
  app.use(express.static(PUBLIC_DIR));

  app.get("/healthz", (_req, res) => {
    res.status(200).json({ status: "ok" });
  });

  app.get("/api/front-page", async (_req, res) => {
    try {
      const [articles, config] = await Promise.all([
        fetchImpl(`${newspaperUrl}/api/articles`),
        fetchImpl(`${newspaperUrl}/api/config`),
      ]);
      if (!articles.ok || !config.ok) {
        res.status(502).json({ error: `newspaper answered ${articles.status}/${config.status}` });
        return;
      }
      const a = (await articles.json()) as { articles?: Article[]; quote?: unknown };
      const c = (await config.json()) as { config?: Config };
      res.json({ ...buildFrontPage(a.articles || [], c.config || {}), quote: a.quote ?? null });
    } catch (e) {
      res.status(502).json({ error: `newspaper unreachable: ${(e as Error).message}` });
    }
  });

  // One story, for the article view when it is opened from a link or a
  // reload rather than from the front page the browser already holds.
  app.get("/api/article/:id", async (req, res) => {
    if (!ARTICLE_ID.test(req.params.id)) {
      res.status(400).json({ error: "not an article id" });
      return;
    }
    try {
      const r = await fetchImpl(`${newspaperUrl}/api/articles`);
      if (!r.ok) {
        res.status(502).json({ error: `newspaper answered ${r.status}` });
        return;
      }
      const { articles = [] } = (await r.json()) as { articles?: Article[] };
      const a = articles.find((x) => x._id === req.params.id);
      if (a) res.json(a);
      else res.status(404).json({ error: "article not found" });
    } catch (e) {
      res.status(502).json({ error: `newspaper unreachable: ${(e as Error).message}` });
    }
  });

  // Passed straight through: the old server counts each fetch as "he opened
  // this", which is the reading signal M2's taste model is built on.
  app.get("/api/full-text/:id", async (req, res) => {
    if (!ARTICLE_ID.test(req.params.id)) {
      res.status(400).json({ error: "not an article id" });
      return;
    }
    try {
      const r = await fetchImpl(`${newspaperUrl}/api/full-text/${req.params.id}`);
      res.status(r.status).type("application/json").send(await r.text());
    } catch (e) {
      res.status(502).json({ error: `newspaper unreachable: ${(e as Error).message}` });
    }
  });

  return app;
}
