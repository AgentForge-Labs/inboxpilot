export type CommercialPlanId =
  | "free"
  | "personal"
  | "pro"
  | "business";

export interface MonthlyPriceTarget {
  currency: "EUR";
  minCents: number | null;
  maxCents: number | null;
  custom: boolean;
}

export const PLAN_PRICE_TARGETS_EUR:
  Readonly<Record<CommercialPlanId, MonthlyPriceTarget>> =
  Object.freeze({
    free: Object.freeze({
      currency: "EUR",
      minCents: 0,
      maxCents: 0,
      custom: false,
    }),
    personal: Object.freeze({
      currency: "EUR",
      minCents: 499,
      maxCents: 599,
      custom: false,
    }),
    pro: Object.freeze({
      currency: "EUR",
      minCents: 999,
      maxCents: 1299,
      custom: false,
    }),
    business: Object.freeze({
      currency: "EUR",
      minCents: null,
      maxCents: null,
      custom: true,
    }),
  });
