// The front page, rendered from /api/front-page with the markup and CSS of
// the ConfigMap app it replaces (M1: parity). Thumbs, "For you" and the menu
// are not carried over: M3 removes the first two and replaces the menu.
const { html, render, useEffect, useState } = window.htmPreact;

const READ_IDS = new Set(JSON.parse(localStorage.getItem("sokrates-post-read") || "[]"));

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
  const rss = a.topic === "RSS";
  return html`
    <div class="${cls} ${isRead ? "is-read" : ""}" data-id=${a._id}>
      ${a.image_url && html`<img class=${big ? "hero-img" : "card-img"} src=${a.image_url} alt="" loading="lazy" onError=${(e) => e.target.remove()} />`}
      <div class="${cls}-content">
        <div class="card-top-row"><span class="kicker-group"><span class="kicker">${a.category || ""}</span></span></div>
        ${big ? html`<h2>${a.title_en}</h2>` : html`<h3>${a.title_en}</h3>`}
        <p>${txt.slice(0, limit)}${txt.length > limit ? "…" : ""}</p>
        <div class="meta">
          <span class="source-type-badge" title=${rss ? "Sourced via RSS feed" : "Sourced via scrape"}>${rss ? "📡" : "🤖"}</span>
          ${" "}${a.source_name || ""} · ${age(a)} · ${readingTime(txt)} min read${isRead ? " · read" : ""}
        </div>
      </div>
    </div>`;
}

function Brief({ a }) {
  return html`
    <div class="brief ${READ_IDS.has(a._id) ? "is-read" : ""}" data-id=${a._id}>
      <span class="kicker">${a.category || ""}</span>
      <span class="brief-title">${a.title_en}</span>
      <span class="meta">${a.source_name || ""} · ${age(a)}</span>
    </div>`;
}

function FrontPage() {
  const [page, setPage] = useState(null);
  const [error, setError] = useState(null);
  useEffect(() => {
    fetch("/api/front-page")
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then(setPage, (e) => setError(e.message));
  }, []);
  if (error) return html`<div class="empty">The paper could not be loaded (${error}).</div>`;
  if (!page) return html`<div class="empty">Loading today's paper…</div>`;
  if (!page.lead) return html`<div class="empty">No articles yet.</div>`;
  return html`
    ${page.quote && html`<div class="quote-strip">“${page.quote}”</div>`}
    <${Card} a=${page.lead} big=${true} />
    <div class="grid">${page.stories.map((a) => html`<${Card} key=${a._id} a=${a} />`)}</div>
    ${page.briefs.length > 0 && html`<section class="briefs"><h4>In brief</h4>${page.briefs.map((a) => html`<${Brief} key=${a._id} a=${a} />`)}</section>`}`;
}

function App() {
  const date = new Date().toLocaleDateString("en-US", { weekday: "long", year: "numeric", month: "long", day: "numeric" });
  return html`
    <header class="masthead"><h1>The Sokrates Post</h1><div class="date">${date}</div></header>
    <main id="main"><${FrontPage} /></main>`;
}

render(html`<${App} />`, document.getElementById("app"));
