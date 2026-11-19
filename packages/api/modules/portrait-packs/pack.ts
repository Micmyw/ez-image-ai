import { createHash, createHmac } from "node:crypto";

import { ORPCError } from "@orpc/server";
import { auth } from "@repo/auth";
import { isAnonymousUser } from "@repo/auth/lib/anonymous-boundary";
import {
	PORTRAIT_CARD_KEYS,
	PORTRAIT_PACK_CARDS,
	PORTRAIT_PACK_SIZE,
	PORTRAIT_PACK_STYLES,
	PORTRAIT_PACK_TRIAL_LIMIT,
} from "@repo/config/portrait-packs";
import {
	getPortraitPackTrials,
	hasPortraitPackPurchase,
	issuePortraitPackTrial,
} from "@repo/database";
import { getBaseUrl } from "@repo/utils";
import { z } from "zod";

import { type ApiRequestContext, publicProcedure } from "../../orpc/procedures";
import { ensureGuestBrowserSubject, readGuestBrowserSubject } from "../media/lib/guest-browser";

const cardsSchema = z
	.array(z.enum(PORTRAIT_CARD_KEYS))
	.length(PORTRAIT_PACK_SIZE)
	.refine((cards) => new Set(cards).size === cards.length);
const stateSchema = z.enum(["guestTrial", "accountTrial", "guestUsed", "accountUsed", "unlocked"]);
const remainingSchema = z.number().int().min(0).max(PORTRAIT_PACK_TRIAL_LIMIT).nullable();

function trialAccess(userId: string | null, used: number) {
	const remaining = PORTRAIT_PACK_TRIAL_LIMIT - used;
	const state = userId
		? remaining
			? "accountTrial"
			: "accountUsed"
		: remaining
			? "guestTrial"
			: "guestUsed";
	return { state, remaining } as const;
}

async function viewer(context: ApiRequestContext, bootstrap: boolean) {
	context.responseHeaders?.set("Cache-Control", "private, no-store");
	context.responseHeaders?.set("X-Robots-Tag", "noindex, nofollow");
	const session = await auth.api.getSession({ headers: context.headers });
	if (session && !isAnonymousUser(session.user)) {
		const hash = createHash("sha256")
			.update(`portrait-pack-account-v1:${session.user.id}`)
			.digest("hex");
		return { subjectKey: `account:${hash}`, userId: session.user.id };
	}
	const browser = bootstrap
		? ensureGuestBrowserSubject(context.headers, context.responseHeaders)
		: readGuestBrowserSubject(context.headers);
	if (!browser)
		throw new ORPCError("PRECONDITION_FAILED", { message: "PORTRAIT_PACK_BROWSER_REQUIRED" });
	return { subjectKey: `browser:${browser}`, userId: null };
}

function makePack(subjectKey: string, requestId: string) {
	const secret = process.env.BETTER_AUTH_SECRET;
	if (!secret || secret.length < 32) throw new Error("PORTRAIT_PACK_CONFIGURATION_REQUIRED");
	const shuffled = PORTRAIT_CARD_KEYS.map((key) => ({
		key,
		score: createHmac("sha256", secret)
			.update(`portrait-pack-v1:${subjectKey}:${requestId}:${key}`)
			.digest("hex"),
	}))
		.sort((left, right) => (left.score < right.score ? -1 : left.score > right.score ? 1 : 0))
		.map(({ key }) => key);
	const featured = PORTRAIT_PACK_STYLES.map((style) =>
		shuffled.find((key) => PORTRAIT_PACK_CARDS[key].style === style),
	);
	const cards = new Set(featured.filter((key) => key !== undefined));
	for (const key of shuffled) {
		if (cards.size === PORTRAIT_PACK_SIZE) break;
		cards.add(key);
	}
	return shuffled.filter((key) => cards.has(key));
}

const status = publicProcedure
	.route({
		method: "GET",
		path: "/portrait-packs/access",
		tags: ["Portrait Packs"],
		summary: "Read the current portrait pack allowance",
		description:
			"Establishes signed browser identity for guests and returns any previous trial cards.",
	})
	.output(
		z.object({ state: stateSchema, remaining: remainingSchema, cards: cardsSchema.nullable() }),
	)
	.handler(async ({ context }) => {
		const { subjectKey, userId } = await viewer(context, true);
		if (userId && (await hasPortraitPackPurchase(userId)))
			return { state: "unlocked", remaining: null, cards: null };
		const issued = await getPortraitPackTrials(subjectKey);
		const receipt = issued.at(-1);
		return {
			...trialAccess(userId, issued.length),
			cards: receipt ? cardsSchema.parse(receipt.cardKeys) : null,
		};
	});

const open = publicProcedure
	.route({
		method: "POST",
		path: "/portrait-packs/open",
		tags: ["Portrait Packs"],
		summary: "Open one portrait pack",
		description:
			"Returns five different artwork cards using an idempotent, owner-scoped request ID.",
	})
	.input(z.object({ requestId: z.uuid() }).strict())
	.output(
		z.object({
			state: stateSchema,
			remaining: remainingSchema,
			cards: cardsSchema,
			opened: z.boolean(),
		}),
	)
	.handler(async ({ context, input }) => {
		const expectedOrigin = new URL(getBaseUrl(process.env.NEXT_PUBLIC_SAAS_URL)).origin;
		if (context.headers.get("origin") !== expectedOrigin) throw new ORPCError("FORBIDDEN");
		const { subjectKey, userId } = await viewer(context, false);
		const cardKeys = makePack(subjectKey, input.requestId);
		if (userId && (await hasPortraitPackPurchase(userId))) {
			return { state: "unlocked", remaining: null, cards: cardKeys, opened: true };
		}
		const { receipt, used } = await issuePortraitPackTrial({
			subjectKey,
			requestId: input.requestId,
			cardKeys,
		});
		return {
			...trialAccess(userId, used),
			cards: cardsSchema.parse(receipt.cardKeys),
			opened: receipt.requestId === input.requestId,
		};
	});

export const portraitPacksRouter = { status, open };
