// The Post's front page, ported from the inline app.js in platform-config
// (deployments/agents/newspaper/configmaps.yaml) so the new app starts at
// parity (M1 of projects/sokrates/projects/nova/sokrates-post-rebuild.md).
// Same window, same order and same editor: one lead, up to eight top stories
// with at most two per section, everything else as briefs. M2 adds the taste
// model on top as one bounded term in the editor's score — with an empty
// reading log it contributes exactly 0 and this stays byte-identical to M1.

import { buildTaste, type Taste } from "./taste.js";

export interface Article {
  _id: string;
  category?: string;
  topic?: string;
  title_en?: string;
  body_en?: string;
  source_name?: string;
  source_url?: string;
  image_url?: string;
  has_full_text?: boolean;
  vault_relevant?: boolean;
  published_at?: string;
  generated_at?: string;
  date?: string;
  feedback?: "up" | "down";
  dismissed?: boolean;
}

export interface CategoryConfig {
  muted?: boolean;
  boost?: number;
}

export interface Config {
  categories?: Record<string, CategoryConfig>;
  display_settings?: { front_page_days?: number };
}

export interface FrontPage {
  lead: Article | null;
  stories: Article[];
  briefs: Article[];
}

export const TOP_STORIES = 8;
export const PER_CATEGORY = 2;
// An image that this many different source articles share is a site-default
// share image (a Google News placeholder, a site logo), not the story's own.
export const STOCK_IMAGE_SOURCES = 3;

const freshness = (a: Article) => a.published_at || a.generated_at || a.date || "";

export function buildFrontPage(
  articles: Article[],
  config: Config,
  now = Date.now(),
  taste: Taste = buildTaste(null),
): FrontPage {
  const cat = (c?: string) => config.categories?.[c || ""] || {};
  const boost = (c?: string) => cat(c).boost || 0;
  const liked = new Map<string, number>();
  const net = new Map<string, number>();
  for (const a of articles) {
    if (a.feedback !== "up" && a.feedback !== "down") continue;
    const c = a.category || "";
    net.set(c, (net.get(c) || 0) + (a.feedback === "up" ? 1 : -1));
    if (a.feedback === "up") liked.set(c, (liked.get(c) || 0) + 1);
  }

  const sorted = [...articles].sort((a, b) => {
    const day = freshness(b).slice(0, 10).localeCompare(freshness(a).slice(0, 10));
    if (day) return day;
    const vault = (b.vault_relevant ? 1 : 0) - (a.vault_relevant ? 1 : 0);
    if (vault) return vault;
    const dial = boost(b.category) - boost(a.category);
    if (dial) return dial;
    const likes = (liked.get(b.category || "") || 0) - (liked.get(a.category || "") || 0);
    if (likes) return likes;
    return freshness(b).localeCompare(freshness(a));
  });

  const visible = sorted.filter((a) => !a.dismissed && !cat(a.category).muted);
  const days = config.display_settings?.front_page_days || 1;
  const cutoff = new Date(now - days * 86400000).toISOString().slice(0, 19) + "Z";
  let page = visible.filter((a) =>
    a.generated_at ? a.generated_at >= cutoff : (a.date || "") >= cutoff.slice(0, 10),
  );
  if (page.length === 0) {
    // A missed print run falls back to the newest day rather than an empty page.
    const newest = visible.reduce((m, a) => ((a.date || "") > m ? a.date || "" : m), "");
    page = newest ? visible.filter((a) => a.date === newest) : [];
  }
  return edit(interleave(page), articles, net, boost, taste);
}

function interleave(articles: Article[]): Article[] {
  const queues = new Map<string, Article[]>();
  for (const a of articles) {
    const c = a.category || "";
    if (!queues.has(c)) queues.set(c, []);
    queues.get(c)!.push(a);
  }
  const out: Article[] = [];
  const qs = [...queues.values()];
  for (let took = true; took; ) {
    took = false;
    for (const q of qs) {
      const a = q.shift();
      if (a) {
        out.push(a);
        took = true;
      }
    }
  }
  return out;
}

function edit(
  list: Article[],
  all: Article[],
  net: Map<string, number>,
  boost: (c?: string) => number,
  taste: Taste,
): FrontPage {
  const sources = new Map<string, Set<string>>();
  for (const a of all) {
    if (!a.image_url) continue;
    if (!sources.has(a.image_url)) sources.set(a.image_url, new Set());
    sources.get(a.image_url)!.add(a.source_url || a._id);
  }
  const score = (a: Article) => {
    const votes = Math.max(-3, Math.min(3, net.get(a.category || "") || 0));
    const own = a.image_url && (sources.get(a.image_url)?.size || 0) < STOCK_IMAGE_SOURCES;
    return (
      3 * boost(a.category) + votes + (own ? 1 : 0) + (a.has_full_text ? 1 : 0) + taste.lift(a)
    );
  };
  const ranked = list.map((a, i) => ({ a, i, s: score(a) })).sort((x, y) => y.s - x.s || x.i - y.i);
  const perCategory = new Map<string, number>();
  const top: Article[] = [];
  for (const { a } of ranked) {
    if (top.length > TOP_STORIES) break;
    if (a.feedback === "down") continue;
    const c = a.category || "";
    if ((perCategory.get(c) || 0) >= PER_CATEGORY) continue;
    perCategory.set(c, (perCategory.get(c) || 0) + 1);
    top.push(a);
  }
  const chosen = new Set(top);
  return { lead: top[0] || null, stories: top.slice(1), briefs: list.filter((a) => !chosen.has(a)) };
}
