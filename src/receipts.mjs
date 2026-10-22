// Real runs on the landing page and /llms.txt.
//
// Articles are Nano Maxi's daily Subnano posts (blurbs are the final copy).
// Guides are the published nanoodle example pages for those same flows.
// Thumbs are shown only from media.nanoodle.com: nanoodle.com sends
// Cross-Origin-Resource-Policy: same-origin, and the landing image check
// refuses any other host. Supabase thumbs stay in the data and are not emitted.
import data from "./receipts.json" with { type: "json" };

export const PROFILE = data.profile;
export const INTRO = data.intro;
export const HEADING = "Real runs, written up";
export const ARTICLES = data.articles;
export const GUIDES = data.guides;

const MEDIA_PREFIX = "https://media.nanoodle.com/";

// Visual description of the hero still. The title sits beside the image.
const ALT = {
  "tin-robot": "Red tin robot with a heart emblem dancing on a rooftop among sunflowers at sunset",
};

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

export function orderedArticles() {
  return ARTICLES.map((article, index) => ({ article, index }))
    .sort((a, b) => (a.article.date < b.article.date ? 1 : a.article.date > b.article.date ? -1 : a.index - b.index))
    .map(({ article }) => article);
}

/** Page-safe thumb, or "" when the file is not on the media host. */
export function pageThumb(article) {
  const thumb = article && article.thumb;
  return typeof thumb === "string" && thumb.startsWith(MEDIA_PREFIX) ? thumb : "";
}

function shortDate(iso) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(iso));
  return match ? `${match[2]}-${match[3]}` : String(iso);
}

function ext(href, className, inner) {
  return `<a class="${className}" href="${esc(href)}" target="_blank" rel="noopener">${inner}</a>`;
}

export function receiptsHtml() {
  const articles = orderedArticles();
  if (!articles.length) return "";
  const [hero, ...rest] = articles;
  const thumb = pageThumb(hero);
  const shot = thumb
    ? `<span class="shot"><img src="${esc(thumb)}" alt="${esc(ALT[hero.key] || hero.title)}" loading="lazy" decoding="async"></span>`
    : "";
  const notes = rest.map((article) => ext(article.url, "note",
    `<span class="when">${esc(shortDate(article.date))}</span>` +
    `<span class="what"><span class="title">${esc(article.title)}</span></span>` +
    `<span class="chip">${esc(article.ability)}</span>`)).join("");
  const guides = GUIDES.map((guide) => ext(guide.href, "guide",
    `<span class="k">guide</span><span class="title">${esc(guide.title)}</span><span class="arr" aria-hidden="true">→</span>`)).join("");
  return `<section class="receipts" id="real-runs" aria-labelledby="real-runs-title">` +
    `<p class="eyebrow">See it run</p>` +
    `<h2 id="real-runs-title">${esc(HEADING)}</h2>` +
    `<p class="lead">${esc(INTRO)}</p>` +
    ext(hero.url, "hero", shot +
      `<span class="copy">` +
        `<span class="meta"><span class="chip">${esc(hero.ability)}</span>` +
        `<span class="muted">· newest · ${esc(hero.date)}</span></span>` +
        `<h3>${esc(hero.title)}</h3>` +
        `<p>${esc(hero.blurb)}</p>` +
        `<span class="cta">Open in Subnano →</span>` +
      `</span>`) +
    `<div class="cols">` +
      `<div class="notes"><h3>More field notes <span class="muted">· Subnano</span></h3>${notes}</div>` +
      `<div class="guides"><h3>Guides <span class="muted">· nanoodle.com</span></h3>${guides}</div>` +
    `</div>` +
    `<p class="more">${ext(PROFILE, "all", "Read all of Nano Maxi's notes →")}</p>` +
    `</section>`;
}

/** Short plain-text twin for /llms.txt. */
export function receiptsLines() {
  const articles = orderedArticles();
  if (!articles.length) return [];
  const [hero] = articles;
  const lines = [
    `## ${HEADING}`,
    ``,
    INTRO,
    `Open in Subnano: ${hero.url}`,
    `Read all of Nano Maxi's notes: ${PROFILE}`,
    ``,
  ];
  for (const article of articles) {
    lines.push(`- ${article.date} ${article.ability}: ${article.title} — ${article.url}`);
    lines.push(`  ${article.blurb}`);
  }
  lines.push(``, `Example guides:`);
  for (const guide of GUIDES) lines.push(`- ${guide.title} — ${guide.href}`);
  return lines;
}

export const RECEIPTS_CSS = `
  .receipts{margin:2.25rem 0 1.35rem}
  .receipts .eyebrow{margin:0 0 .45rem}
  .receipts h2{font-size:clamp(1.7rem,4vw,2.15rem);text-align:center;letter-spacing:-.02em;margin:0 0 .45rem;text-wrap:balance}
  .receipts .lead{color:var(--muted);text-align:center;max-width:38rem;margin:0 auto 1.3rem;text-wrap:pretty}
  .receipts a.hero,.receipts a.note,.receipts a.guide{color:inherit;text-decoration:none}
  .receipts a:focus-visible{outline:2px solid var(--accent);outline-offset:3px}
  .hero{display:grid;grid-template-columns:minmax(0,1.18fr) minmax(0,.92fr);background:var(--card);border:1px solid var(--accent);border-radius:16px;overflow:hidden;box-shadow:0 0 28px rgba(45,212,191,.16)}
  .hero:hover .cta{filter:brightness(1.08)}
  .shot{position:relative;display:block;min-height:220px;background:#0b1016}
  .shot img{position:absolute;inset:0;width:100%;height:100%;object-fit:cover;display:block}
  .copy{padding:1.15rem 1.2rem 1.25rem;display:flex;flex-direction:column;align-items:flex-start;gap:.5rem;min-width:0}
  .meta{display:flex;flex-wrap:wrap;align-items:center;gap:.4rem;font-size:.84rem}
  .hero h3{margin:0;font-size:clamp(1.15rem,2vw,1.38rem);line-height:1.28;letter-spacing:-.02em;text-wrap:balance}
  .copy p{margin:0;color:var(--muted);font-size:.92rem}
  .receipts .chip{background:rgba(45,212,191,.13);color:#5eead4;border:1px solid rgba(45,212,191,.28)}
  .cta{display:inline-block;margin-top:.2rem;font-weight:700;font-size:.92rem;line-height:1.2;padding:.5rem .95rem;border-radius:10px;background:var(--accent);color:#04201d}
  .cols{display:grid;grid-template-columns:minmax(0,1.55fr) minmax(0,.9fr);gap:1.6rem 1.75rem;margin-top:1.35rem}
  .cols h3{font-size:.98rem;font-weight:600;margin:0 0 .3rem}
  .cols h3 .muted{font-weight:500}
  .note,.guide{display:grid;align-items:start;padding:.68rem .1rem;border-bottom:1px solid var(--edge)}
  .note{grid-template-columns:3.25rem minmax(0,1fr) auto;column-gap:.7rem}
  .note .when,.guide .k{color:var(--muted);font:.78rem/1.35 ui-monospace,monospace;padding-top:.15rem}
  .note .what,.guide .title{min-width:0}
  .note .title,.guide .title{font-weight:600;line-height:1.35}
  .note .chip{justify-self:end}
  .note:hover,.guide:hover{background:rgba(45,212,191,.05)}
  .note:hover .title,.guide:hover .title{color:var(--accent)}
  .guide{grid-template-columns:3.25rem minmax(0,1fr) auto;column-gap:.65rem;align-items:center}
  .guide .arr{color:var(--accent)}
  .more{margin:1rem 0 0}
  .more a{font-weight:600}
  @media (min-width:721px){
    .shot{height:100%;min-height:100%}
  }
  @media (max-width:720px){
    .hero{grid-template-columns:1fr}
    .shot{aspect-ratio:16/9;min-height:0}
    .cols{grid-template-columns:1fr;gap:1.25rem}
    .note{grid-template-columns:2.7rem minmax(0,1fr)}
    .note .chip{grid-column:2;justify-self:start;margin-top:.28rem}
    .guide{grid-template-columns:2.7rem minmax(0,1fr) auto}
    .receipts h2{font-size:1.65rem}
  }
`;
