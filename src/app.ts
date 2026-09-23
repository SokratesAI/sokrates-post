import express from "express";
import { fileURLToPath } from "node:url";
import { buildFrontPage, type Article, type Config } from "./frontPage.js";
import { EventLog, parseEvent } from "./events.js";

// The live paper is still written and served by the old `newspaper` app; the
// new one reads it over the cluster network until M5 moves the data across.
const PUBLIC_DIR = fileURLToPath(new URL("../public", import.meta.url));
// The newspaper's own id shape (ARTICLE_ID_PATTERN in its server.py); anything
// else is refused here rather than forwarded into its URL space.
const ARTICLE_ID = /^art-[0-9a-f]{16}$/;

export function createApp(
  newspaperUrl: string,
  fetchImpl: typeof fetch = fetch,
  dataDir: string = process.env.DATA_DIR ?? "/data",
) {
  const app = express();
  const events = new EventLog(dataDir);
  app.use(express.static(PUBLIC_DIR));
  // An open is tiny; a front-page event carries up to 60 impressions, so the
  // worst honest body is ~12kb. 64kb leaves room for that and still refuses a
  // flood -- and the client swallows errors, so a limit that clipped a real
  // event would lose data in silence rather than report it.
  app.use(express.json({ limit: "64kb" }));

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

  // What he opened. The front page renders from data the browser already
  // holds, so an open never reaches the server on its own -- the client has
  // to say so, and this is where it says it.
  app.post("/api/events", async (req, res) => {
    const e = parseEvent(req.body);
    if (!e) {
      res.status(400).json({ error: "not an event" });
      return;
    }
    try {
      await events.append(e);
      res.status(204).end();
    } catch (err) {
      res.status(500).json({ error: `could not record: ${(err as Error).message}` });
    }
  });

  // So the log is readable without a shell on the pod, and so M2's taste
  // model has one place to read rather than parsing the file itself.
  app.get("/api/events/summary", async (_req, res) => {
    try {
      res.json(await events.summary());
    } catch (err) {
      res.status(500).json({ error: `could not read log: ${(err as Error).message}` });
    }
  });

  return app;
}
