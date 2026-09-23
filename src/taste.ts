// M2's taste model: rank the front page by what he actually reads.
//
// The signal is opens per impression, per topic, read off the log `events.ts`
// writes. The denominator is the whole point — a topic printed forty times and
// opened twice is not the same taste as one printed twice and opened twice, and
// a count of opens cannot tell them apart. That is why M2 shipped impressions
// before it shipped this.
//
// MEASURED ON THE LIVE LOG BEFORE WRITING THIS, 2026-09-23 16:05 Oslo: two
// events, both mine — one probe `open` under category `Probe`, and one headless
// front-page load carrying 237 impressions across 99 topics and 32 categories.
// `byTopic` is empty. **There is no human reading in the log yet**, so this
// model is fitted to nothing today, and it goes unattended for a month.
//
// So it is built to be a no-op until it has evidence, rather than to be clever:
// with no opens recorded, `buildTaste` returns a model whose lift is 0 for every
// article, and the front page ranks byte-identically to the M1 ranking that is
// live now. It starts mattering the first time he opens a story, and it can only
// ever move a story by ±TASTE_WEIGHT, which is less than the explicit category
// dial he sets by hand.

import type { Summary } from "./events.js";

/**
 * How far a fully-confident topic may move a story in `frontPage`'s score.
 *
 * Deliberately small. The two signals it sits beside are ones Edvard sets by
 * hand: the category dial is worth 3 points a step and a run of thumbs is worth
 * up to 3. At 1 the whole taste swing between a topic he always reads and one he
 * never touches is 2 points, so it can never overturn either of them — it only
 * decides between stories his explicit signals rank equally, which is almost all
 * of them (62 of 2,288 articles carry a thumb). Inferred taste losing to stated
 * taste is the right way round, and it matters more than usual for a model that
 * goes a month with nobody able to turn it down.
 */
export const TASTE_WEIGHT = 1;
/**
 * Impressions of pull toward the overall rate. A topic with few impressions
 * sits near the baseline no matter how it was opened; it takes real volume to
 * move. This is the only threshold in the model — a separate minimum-impression
 * gate would be a second number saying the same thing, so there isn't one.
 */
export const PRIOR_IMPRESSIONS = 25;

export interface TasteInput {
  category?: string;
  topic?: string;
}

export interface Taste {
  /** True when the log holds at least one open. False means every lift is 0. */
  readonly informed: boolean;
  /** Overall opens per impression, or 0 when there is nothing to divide. */
  readonly baseline: number;
  /** −TASTE_WEIGHT … +TASTE_WEIGHT. Exactly 0 whenever `informed` is false. */
  lift(a: TasteInput): number;
}

const NEUTRAL: Taste = { informed: false, baseline: 0, lift: () => 0 };

const total = (counts: Record<string, number>) =>
  Object.values(counts).reduce((n, v) => n + v, 0);

function axis(
  opens: Record<string, number>,
  shown: Record<string, number>,
  baseline: number,
): (key: string | undefined) => number | null {
  return (key) => {
    if (!key) return null;
    const impressions = shown[key] || 0;
    // Never printed, as far as the log knows, so it has no rate of its own.
    if (impressions <= 0) return null;
    const rate =
      ((opens[key] || 0) + PRIOR_IMPRESSIONS * baseline) / (impressions + PRIOR_IMPRESSIONS);
    const relative = rate / baseline - 1;
    return TASTE_WEIGHT * Math.max(-1, Math.min(1, relative));
  };
}

/**
 * Build the model from a reading-log summary.
 *
 * `byTopic`/`byCategory` count `open` and `full-text` alike, so a story he
 * opened and then read all the way through counts twice — which is the
 * weighting we want and needs no extra arithmetic here.
 */
export function buildTaste(summary: Summary | null | undefined): Taste {
  if (!summary) return NEUTRAL;
  // An axis is usable only when both halves of its rate exist: opens to learn
  // from and impressions to divide by. Opens with no impressions is a log
  // written by something that never reported a front page, and a rate over
  // nothing is not a small number, it is no number.
  //
  // The numerator counts only keys that were also recorded as shown. An open
  // on a key no front page ever carried has no denominator of its own and
  // cannot be part of an opens-per-impression rate -- and the live log holds
  // exactly one such row, my own probe under the category `Probe`, whose
  // article id is not in the newspaper's store at all. Without this filter
  // that single junk row gives the whole category axis a non-zero base rate,
  // every category that was genuinely on screen scores below it, and the model
  // reorders the front page while believing it has learned nothing. Cycle
  // 2083 wrote that the model would have to discard that row; this is where.
  const counted = (opens: Record<string, number>, shown: Record<string, number>) =>
    Object.entries(opens).reduce((sum, [k, v]) => sum + (shown[k] ? v : 0), 0);
  const rate = (opens: Record<string, number>, shown: Record<string, number>) => {
    const d = total(shown);
    return d > 0 ? counted(opens, shown) / d : 0;
  };
  const topicBase = rate(summary.byTopic, summary.shownByTopic);
  const categoryBase = rate(summary.byCategory, summary.shownByCategory);
  const byTopic = topicBase > 0 ? axis(summary.byTopic, summary.shownByTopic, topicBase) : null;
  const byCategory =
    categoryBase > 0 ? axis(summary.byCategory, summary.shownByCategory, categoryBase) : null;
  // A base rate of zero is the state the log is in today: impressions recorded
  // and nothing opened. There is nothing to learn from it and nothing to say.
  if (!byTopic && !byCategory) return NEUTRAL;

  const opens =
    counted(summary.byTopic, summary.shownByTopic) +
    counted(summary.byCategory, summary.shownByCategory);
  const shown = total(summary.shownByTopic) + total(summary.shownByCategory);

  return {
    informed: true,
    baseline: opens / shown,
    // Topic first, because it is the finer axis, then category. The live log's
    // topics are not uniformly useful — 90 of its 237 impressions carry the
    // catch-all topic `RSS` — but a catch-all earns a lift near the baseline by
    // construction rather than by being special-cased, which is the honest
    // answer for a label that means "unclassified".
    lift: (a) => byTopic?.(a.topic) ?? byCategory?.(a.category) ?? 0,
  };
}
