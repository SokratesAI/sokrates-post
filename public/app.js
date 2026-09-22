// The front page and the article view, rendered from /api/front-page with the
// markup and CSS of the ConfigMap app they replace (M1: parity). Thumbs, "For
// you" and the menus are not carried over: M3 removes the first two and
// replaces the menus, so the article view has no options menu yet.
const { html, render, useEffect, useState } = window.htmPreact;

const READ_KEY = "sokrates-post-read";
const READ_IDS = new Set(JSON.parse(localStorage.getItem(READ_KEY) || "[]"));
function markRead(id) {
  if (READ_IDS.has(id)) return;
  READ_IDS.add(id);
  localStorage.setItem(READ_KEY, JSON.stringify([...READ_IDS]));
}

// Where the front page was scrolled to when a story was opened, so Back lands
// on the same story instead of the masthead.
let frontScroll = 0;
function openArticle(id) {
  frontScroll = window.scrollY;
  location.hash = `#/article/${id}`;
}

function domainFromUrl(url) {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch (e) {
    return "";
  }
}

const SourceBadge = ({ a }) => {
  const rss = a.topic === "RSS";
  return html`<span class="source-type-badge" title=${rss ? "Sourced via RSS feed" : "Sourced via scrape"}>${rss ? "📡" : "🤖"}</span>`;
};

function timeAgo(iso) {
  if (!iso) return "";
  const diffMs = Date.now() - new Date(iso).getTime();
  const h = Math.floor(diffMs / 3600000);
  if (h < 1) return `${Math.max(1, Math.floor(diffMs / 60000))}m ago`;
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

function age(a) {
  if (a.published_at) return timeAgo(a.published_at);
  if (a.generated_at) return `added ${timeAgo(a.generated_at)}`;
  return "";
}

const readingTime = (t) => Math.max(1, Math.round((t || "").trim().split(/\s+/).filter(Boolean).length / 200));

function Card({ a, big }) {
  const cls = big ? "hero" : "card";
  const txt = a.body_en || "";
  const limit = big ? 220 : 110;
  const isRead = READ_IDS.has(a._id);
  return html`
    <div class="${cls} ${isRead ? "is-read" : ""}" data-id=${a._id} onClick=${() => openArticle(a._id)}>
      ${a.image_url && html`<img class=${big ? "hero-img" : "card-img"} src=${a.image_url} alt="" loading="lazy" onError=${(e) => e.target.remove()} />`}
      <div class="${cls}-content">
        <div class="card-top-row"><span class="kicker-group"><span class="kicker">${a.category || ""}</span></span></div>
        ${big ? html`<h2>${a.title_en}</h2>` : html`<h3>${a.title_en}</h3>`}
        <p>${txt.slice(0, limit)}${txt.length > limit ? "…" : ""}</p>
        <div class="meta">
          <${SourceBadge} a=${a} />${" "}${a.source_name || ""} · ${age(a)} · ${readingTime(txt)} min read${isRead ? " · read" : ""}
        </div>
      </div>
    </div>`;
}

function Brief({ a }) {
  return html`
    <div class="brief ${READ_IDS.has(a._id) ? "is-read" : ""}" data-id=${a._id} onClick=${() => openArticle(a._id)}>
      <span class="kicker">${a.category || ""}</span>
      <span class="brief-title">${a.title_en}</span>
      <span class="meta">${a.source_name || ""} · ${age(a)}</span>
    </div>`;
}

function FrontPage({ page, error }) {
  useEffect(() => {
    if (page) window.scrollTo(0, frontScroll);
  }, [page]);
  if (error) return html`<div class="empty">The paper could not be loaded (${error}).</div>`;
  if (!page) return html`<div class="empty">Loading today's paper…</div>`;
  if (!page.lead) return html`<div class="empty">No articles yet.</div>`;
  return html`
    ${page.quote && html`<div class="quote-strip">“${page.quote}”</div>`}
    <${Card} a=${page.lead} big=${true} />
    <div class="grid">${page.stories.map((a) => html`<${Card} key=${a._id} a=${a} />`)}</div>
    ${page.briefs.length > 0 && html`<section class="briefs"><h4>In brief</h4>${page.briefs.map((a) => html`<${Brief} key=${a._id} a=${a} />`)}</section>`}`;
}

function FullText({ a }) {
  const [text, setText] = useState(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    if (!a.has_full_text) return;
    fetch(`/api/full-text/${a._id}`)
      .then((r) => r.json())
      .then((d) => (d.full_text_en ? setText(d.full_text_en) : Promise.reject(new Error(d.error || "empty"))))
      .catch(() => setFailed(true));
  }, [a._id]);
  if (!a.has_full_text) return null;
  const paras = (text || "").split(/\n{2,}/).map((p) => p.trim()).filter(Boolean);
  return html`
    <div class="full-text">
      <h3 class="full-text-title">Full Article</h3>
      ${failed
        ? html`<p class="meta">Could not load the full article. The summary above is complete.</p>`
        : text === null
          ? html`<p class="meta">Loading…</p>`
          : paras.map((p) => html`<p>${p}</p>`)}
    </div>`;
}

function ArticleView({ id, page }) {
  const onPage = page && [page.lead, ...page.stories, ...page.briefs].find((x) => x && x._id === id);
  const [fetched, setFetched] = useState(null);
  const [error, setError] = useState(null);
  const a = onPage || fetched;
  useEffect(() => {
    window.scrollTo(0, 0);
    if (onPage) return;
    fetch(`/api/article/${encodeURIComponent(id)}`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(r.status === 404 ? "not found" : `HTTP ${r.status}`))))
      .then(setFetched, (e) => setError(e.message));
  }, [id]);
  useEffect(() => {
    if (a) markRead(a._id);
  }, [a && a._id]);
  if (!a) return html`<div class="empty">${error ? `Article ${error}.` : "Loading…"}</div>`;
  const domain = domainFromUrl(a.source_url);
  return html`
    <div class="article-view">
      <div class="article-top-row">
        <button class="back" onClick=${() => (history.length > 1 ? history.back() : (location.hash = "#/"))}>← Back</button>
      </div>
      ${a.image_url && html`<img class="detail-img" src=${a.image_url} alt="" loading="lazy" onError=${(e) => e.target.remove()} />`}
      <div class="card-top-row"><span class="kicker">${a.category || ""}</span></div>
      <h2>${a.title_en}</h2>
      <div class="meta"><${SourceBadge} a=${a} />${" "}${a.source_name || ""}${domain ? ` (${domain})` : ""} · ${age(a)} · ${readingTime(a.body_en)} min read</div>
      <div class="body">${a.body_en || ""}</div>
      ${a.source_url && html`<a class="source" href=${a.source_url} target="_blank" rel="noopener">Read original ↗</a>`}
      <${FullText} key=${a._id} a=${a} />
    </div>`;
}

const route = () => {
  const m = (location.hash || "").match(/^#\/article\/(.+)$/);
  return m ? decodeURIComponent(m[1]) : null;
};

function App() {
  const [articleId, setArticleId] = useState(route());
  const [page, setPage] = useState(null);
  const [error, setError] = useState(null);
  useEffect(() => {
    const onHash = () => setArticleId(route());
    window.addEventListener("hashchange", onHash);
    fetch("/api/front-page")
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then(setPage, (e) => setError(e.message));
    return () => window.removeEventListener("hashchange", onHash);
  }, []);
  const date = new Date().toLocaleDateString("en-US", { weekday: "long", year: "numeric", month: "long", day: "numeric" });
  return html`
    <header class="masthead"><h1>The Sokrates Post</h1><div class="date">${date}</div></header>
    <main id="main">
      ${articleId ? html`<${ArticleView} key=${articleId} id=${articleId} page=${page} />` : html`<${FrontPage} page=${page} error=${error} />`}
    </main>`;
}

render(html`<${App} />`, document.getElementById("app"));
