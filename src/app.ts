import express from "express";
import { fileURLToPath } from "node:url";
import { buildFrontPage, type Article, type Config } from "./frontPage.js";

// The live paper is still written and served by the old `newspaper` app; the
// new one reads it over the cluster network until M5 moves the data across.
const PUBLIC_DIR = fileURLToPath(new URL("../public", import.meta.url));

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

  return app;
}
