import { z } from "zod";

export const CREDIT_PACK_KEYS = [
	"credits-1500",
	"credits-3000",
	"credits-5000",
	"credits-8000",
] as const;

export const creditPackKeySchema = z.enum(CREDIT_PACK_KEYS);

export type CreditPackKey = z.infer<typeof creditPackKeySchema>;

export interface PublicCreditPack {
	readonly packKey: CreditPackKey;
	readonly baseCredits: number;
	readonly subscriberCredits: number;
	readonly subscriberBonusPercent: number;
	readonly price: {
		readonly amount: number;
		readonly currency: "USD";
	};
	readonly expiryMonths: number;
}

const publicCreditPacks = [
	{
		packKey: "credits-1500",
		baseCredits: 1_500,
		subscriberCredits: 1_800,
		subscriberBonusPercent: 20,
		price: { amount: 59, currency: "USD" },
		expiryMonths: 6,
	},
	{
		packKey: "credits-3000",
		baseCredits: 3_000,
		subscriberCredits: 3_600,
		subscriberBonusPercent: 20,
		price: { amount: 109, currency: "USD" },
		expiryMonths: 6,
	},
	{
		packKey: "credits-5000",
		baseCredits: 5_000,
		subscriberCredits: 6_000,
		subscriberBonusPercent: 20,
		price: { amount: 169, currency: "USD" },
		expiryMonths: 6,
	},
	{
		packKey: "credits-8000",
		baseCredits: 8_000,
		subscriberCredits: 9_600,
		subscriberBonusPercent: 20,
		price: { amount: 259, currency: "USD" },
		expiryMonths: 6,
	},
] as const satisfies readonly PublicCreditPack[];

export const PUBLIC_CREDIT_PACKS: readonly PublicCreditPack[] = Object.freeze(
	publicCreditPacks.map((pack) =>
		Object.freeze({
			...pack,
			price: Object.freeze({ ...pack.price }),
		}),
	),
);

export function getPublicCreditPack(packKey: CreditPackKey): PublicCreditPack {
	const pack = PUBLIC_CREDIT_PACKS.find((candidate) => candidate.packKey === packKey);
	if (!pack) throw new Error(`Unknown credit pack: ${packKey}`);
	return pack;
}
