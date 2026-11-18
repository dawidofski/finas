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
    body: 'Money spent in one place is money that is not available for something else. That trade-off is called an opportunity cost. A line running over shows where it appears in your own figures, and whether the mix of what you spent on matches what matters to you is yours to say.',
  },
  'small-purchases-add-up': {
    topic: 'small-purchase-accumulation',
    title: 'Small amounts and their total',
    body: 'Each small purchase is a small amount, and the total across a month is a different figure. You can compare that total with what those purchases are worth to you.',
  },
  'savings-inconsistent': {
    topic: 'savings-consistency',
    title: 'Saving on a schedule',
    body: 'Saving regularly means setting aside an amount on a repeating schedule, whatever its size. Months with nothing set aside are not a verdict. In your records they mark where a routine could start, at an amount that suits your situation.',
  },
  'discretionary-rising': {
    topic: 'lifestyle-inflation',
    title: 'Spending on wants over time',
    body: 'Lifestyle inflation is the name for spending on wants rising over time. In your records this spending has gone up over recent months. Whether that matches what you want from your money is yours to judge.',
  },
  'regret-cluster': {
    topic: 'impulse-spending',
    title: 'Wanting and buying',
    body: 'You marked some of these purchases as not worth it. An impulse purchase is one made quickly, with little time between wanting and buying. A question you can ask of your own purchases is whether any of these were bought quickly. If so, a pause before buying gives you time to see whether the wish stays.',
  },
  'unusual-spend': {
    topic: 'value-of-money',
    title: 'What an amount gave you',
    body: 'Value for money means what an amount gave you in return, as you measure it. An unusual payment is a chance to look at what it was for: a bill, a one-off cost, or something you chose. Whether it was worth it is for you to say, and some payments are not choices at all.',
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
    body: 'Choose a few days this month on which you buy nothing beyond essentials such as groceries, rent, bills and transport. You pick how many and which days. Afterwards, you can look at how those days compare with the others.',
  },
  'twenty-four-hour-rule': {
    id: 'twenty-four-hour-rule',
    title: 'Wait a day on a want',
    body: 'When you notice a wish to buy something that was not planned, note it and wait a day before deciding. If it still matters the next day, decide knowing that. If it does not, nothing was lost.',
  },
  'subscription-review': {
    id: 'subscription-review',
    title: 'Read through what repeats',
    body: 'Go through the payments that recur each month and, for each, ask whether you still use it and still want it. Decide for each one whether to keep it or end it.',
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
  'savings-inconsistent': ['savings-step-up'],
  'unusual-spend': [],
  'discretionary-rising': ['reduce-category', 'no-spend-days'],
  'regret-cluster': ['twenty-four-hour-rule', 'no-spend-days'],
}

/** Said in place of silence, so a challenge that cannot run yet never reads as a bug. */
const NEEDS_RECURRING = 'The app cannot list subscriptions, so it cannot show which payments repeat.'

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
