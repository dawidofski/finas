import type { RecommendationId } from './recommendations'

/**
 * The six lessons and five challenges of §13.2, each attached to the recommendation that prompts it.
 *
 * TEACHING IS CONTEXTUAL. A note is shown only beside the advice that triggered it, so `noteFor` answers null for an
 * id with no note rather than offering a lecture nobody asked for. Six ids carry six topics, one each:
 *
 *   overspent-category     -> opportunity-cost          (a line ran over: what the money would otherwise have done)
 *   small-purchases-add-up -> small-purchase-accumulation
 *   savings-inconsistent   -> savings-consistency
 *   discretionary-rising   -> lifestyle-inflation       (wants rising over months)
 *   regret-cluster         -> impulse-spending          (purchases the owner themselves marked regretted)
 *   unusual-spend          -> value-of-money            (one unusual amount: what it was worth to the owner)
 *
 * COPY RULES. A1: no judging, no presumption about means; every challenge is an invitation the owner sizes
 * themselves. A2: nothing is said to have caused anything. A7: no number appears for its own sake, so the copy
 * names none. Pure data: no clock, no arithmetic.
 */
export type Topic =
  | 'opportunity-cost' | 'impulse-spending' | 'lifestyle-inflation'
  | 'small-purchase-accumulation' | 'savings-consistency' | 'value-of-money'
export interface Note { topic: Topic; title: string; body: string }
export type ChallengeId =
  | 'reduce-category' | 'no-spend-days' | 'twenty-four-hour-rule'
  | 'subscription-review' | 'savings-step-up'
export interface Challenge { id: ChallengeId; title: string; body: string; available: boolean; why?: string }

const NOTES: Readonly<Record<RecommendationId, Note>> = {
  'overspent-category': {
    topic: 'opportunity-cost',
    title: 'What the same money could have done',
    body: 'Every amount spent in one place is an amount that was not spent or saved somewhere else. Economists call that the opportunity cost. A line running over is a moment to look at what that money was standing in for, and to decide whether this is the trade you wanted to make. Either answer is fine.',
  },
  'small-purchases-add-up': {
    topic: 'small-purchase-accumulation',
    title: 'Small amounts are still amounts',
    body: 'A single small purchase rarely gets a second look. Added together over a month they can be a noticeable part of what you spend. The total is shown so you can see the whole of it at once, and decide whether it matches what those purchases are worth to you.',
  },
  'savings-inconsistent': {
    topic: 'savings-consistency',
    title: 'Regular beats large',
    body: 'Savings tend to grow most reliably when a similar amount is set aside on a similar schedule, whatever its size. Months where nothing was set aside are not a verdict. They show where a routine could be added, at whatever amount suits your situation.',
  },
  'discretionary-rising': {
    topic: 'lifestyle-inflation',
    title: 'When spending drifts upward',
    body: 'Spending on wants can creep up gradually as income or habits shift, often without a single decision marking the change. Seeing it laid out over several months makes the drift visible. Whether it reflects what you want from your money is yours to judge.',
  },
  'regret-cluster': {
    topic: 'impulse-spending',
    title: 'A pause between wanting and buying',
    body: 'You marked several of these purchases as ones you regretted, and they share something in common. Purchases made on the spur of the moment are often the ones that look different a day later. A short pause before buying gives the wish time to settle or fade.',
  },
  'unusual-spend': {
    topic: 'value-of-money',
    title: 'What an amount is worth to you',
    body: 'The same amount can be well spent for one person and poorly spent for another. What matters is what it gave you in return. An unusual payment is a chance to ask what it bought, and whether that is how you would choose to use that amount again.',
  },
}

export function noteFor(id: RecommendationId): Note | null {
  return NOTES[id] ?? null
}

const CHALLENGES: Readonly<Record<ChallengeId, Omit<Challenge, 'available' | 'why'>>> = {
  'reduce-category': {
    id: 'reduce-category',
    title: 'Try a different line for one month',
    body: 'Pick one category and set its line at an amount you choose, higher or lower than now. At the end of the month, look at how it went and keep or change it. The amount is entirely yours.',
  },
  'no-spend-days': {
    id: 'no-spend-days',
    title: 'Days with no spending',
    body: 'Choose a few days this month on which you buy nothing beyond what is already committed. You pick how many and which days. Afterwards, you can look at how those days compare with the others.',
  },
  'twenty-four-hour-rule': {
    id: 'twenty-four-hour-rule',
    title: 'Wait a day on a want',
    body: 'When you notice a wish to buy something that was not planned, note it and wait a day before deciding. If it still matters the next day, buy it knowing that. If it does not, nothing was lost.',
  },
  'subscription-review': {
    id: 'subscription-review',
    title: 'Read through what repeats',
    body: 'Go through the payments that recur each month and, for each, ask whether you still use it and still want it. Keep what earns its place and end what does not.',
  },
  'savings-step-up': {
    id: 'savings-step-up',
    title: 'Set aside a steady amount',
    body: 'Choose an amount that suits you and move it to savings on the same day each month. Over time, you can raise it when it feels comfortable, or leave it where it is.',
  },
}

const OFFERED: Readonly<Record<RecommendationId, readonly ChallengeId[]>> = {
  'overspent-category': ['reduce-category', 'no-spend-days'],
  'small-purchases-add-up': ['twenty-four-hour-rule', 'subscription-review', 'no-spend-days'],
  'savings-inconsistent': [],
  'unusual-spend': ['twenty-four-hour-rule'],
  'discretionary-rising': ['reduce-category', 'no-spend-days'],
  'regret-cluster': ['twenty-four-hour-rule', 'no-spend-days'],
}

/** Said in place of silence, so a challenge that cannot run yet never reads as a bug. */
const NEEDS_RECURRING = 'The app cannot list subscriptions yet, so it cannot show which payments repeat. This challenge will become available once it can.'

/**
 * The challenges that go with a recommendation. `subscription-review` is returned wherever it applies: with
 * `available: false` and a `why` when recurring-payment data is absent (not built yet, Plan 8), never omitted.
 */
export function challengesFor(id: RecommendationId, hasRecurringData: boolean): Challenge[] {
  return (OFFERED[id] ?? []).map((c): Challenge => {
    const base = CHALLENGES[c]
    if (c === 'subscription-review' && !hasRecurringData) return { ...base, available: false, why: NEEDS_RECURRING }
    return { ...base, available: true }
  })
}

/** For tests and any screen that lists everything. */
export const ALL_CHALLENGE_IDS: readonly ChallengeId[] = Object.keys(CHALLENGES) as ChallengeId[]
export const ALL_RECOMMENDATION_IDS: readonly RecommendationId[] = Object.keys(NOTES) as RecommendationId[]
