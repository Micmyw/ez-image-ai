import { call } from "@orpc/server";
import { auth } from "@repo/auth";
import {
	PORTRAIT_CARD_KEYS,
	PORTRAIT_PACK_CARDS,
	PORTRAIT_PACK_STYLES,
} from "@repo/config/portrait-packs";
import {
	getPortraitPackTrials,
	hasPortraitPackPurchase,
	issuePortraitPackTrial,
} from "@repo/database";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { portraitPacksRouter } from "./pack";

vi.mock("@repo/auth", () => ({ auth: { api: { getSession: vi.fn() } } }));
vi.mock("@repo/database", () => ({
	getPortraitPackTrials: vi.fn(),
	hasPortraitPackPurchase: vi.fn(),
	issuePortraitPackTrial: vi.fn(),
}));

const origin = "https://packs.example";
const firstRequest = "630db51b-0ad5-4f20-acc2-a3a5d5b23032";
const secondRequest = "1553942f-7e12-46dd-b120-fa881b2699c7";
const session = (id: string, isAnonymous = false) =>
	({ user: { id, isAnonymous, email: `${id}@example.com` } }) as Awaited<
		ReturnType<typeof auth.api.getSession>
	>;
const context = (cookie = "", requestOrigin = origin) => ({
	headers: new Headers({ origin: requestOrigin, cookie }),
	responseHeaders: new Headers(),
});

describe("portrait pack access", () => {
	beforeEach(() => {
		vi.resetAllMocks();
		vi.stubEnv("BETTER_AUTH_SECRET", "portrait-pack-test-secret-at-least-32-characters");
		vi.stubEnv("NEXT_PUBLIC_SAAS_URL", origin);
		vi.mocked(auth.api.getSession).mockResolvedValue(null);
		vi.mocked(getPortraitPackTrials).mockResolvedValue([]);
		vi.mocked(hasPortraitPackPurchase).mockResolvedValue(false);
		vi.mocked(issuePortraitPackTrial).mockImplementation(async (receipt) => ({ receipt, used: 1 }));
	});
	afterEach(() => vi.unstubAllEnvs());

	it("issues no trial until a signed browser opens it and separates the registered trial", async () => {
		const initial = context();
		expect(await call(portraitPacksRouter.status, undefined, { context: initial })).toEqual({
			state: "guestTrial",
			remaining: 2,
			cards: null,
		});
		const cookie = initial.responseHeaders.get("Set-Cookie")!.split(";")[0]!;
		expect(initial.responseHeaders.get("Set-Cookie")).toContain("HttpOnly");
		expect(initial.responseHeaders.get("Cache-Control")).toBe("private, no-store");
		expect(issuePortraitPackTrial).not.toHaveBeenCalled();
		const browser = context(cookie);
		const guest = await call(
			portraitPacksRouter.open,
			{ requestId: firstRequest },
			{ context: browser },
		);
		expect(guest).toMatchObject({ state: "guestTrial", remaining: 1, opened: true });
		expect(new Set(guest.cards).size).toBe(5);
		expect(guest.cards.every((key) => PORTRAIT_CARD_KEYS.includes(key))).toBe(true);
		expect(new Set(guest.cards.map((key) => PORTRAIT_PACK_CARDS[key].style))).toEqual(
			new Set(PORTRAIT_PACK_STYLES),
		);
		const guestSubject = vi.mocked(issuePortraitPackTrial).mock.calls[0]![0].subjectKey;
		expect(guestSubject).toMatch(/^browser:[0-9a-f]{64}$/);
		vi.mocked(auth.api.getSession).mockResolvedValue(session("real-account"));
		const signedIn = await call(
			portraitPacksRouter.open,
			{ requestId: firstRequest },
			{ context: browser },
		);
		expect(signedIn).toMatchObject({ state: "accountTrial", remaining: 1 });
		expect(issuePortraitPackTrial).toHaveBeenLastCalledWith(
			expect.objectContaining({ subjectKey: expect.stringMatching(/^account:[0-9a-f]{64}$/) }),
		);
	});

	it("replays persisted cards after both packs are used and refuses a fresh request", async () => {
		vi.mocked(auth.api.getSession).mockResolvedValue(session("real-account"));
		const receipt = { requestId: firstRequest, cardKeys: PORTRAIT_CARD_KEYS.slice(0, 5) };
		vi.mocked(issuePortraitPackTrial).mockResolvedValue({ receipt, used: 2 });
		vi.mocked(getPortraitPackTrials).mockResolvedValue([
			{ ...receipt, requestId: "previous-request" },
			receipt,
		]);
		await expect(
			call(portraitPacksRouter.open, { requestId: firstRequest }, { context: context() }),
		).resolves.toEqual({
			state: "accountUsed",
			remaining: 0,
			cards: receipt.cardKeys,
			opened: true,
		});
		await expect(
			call(portraitPacksRouter.open, { requestId: secondRequest }, { context: context() }),
		).resolves.toEqual({
			state: "accountUsed",
			remaining: 0,
			cards: receipt.cardKeys,
			opened: false,
		});
		await expect(
			call(portraitPacksRouter.status, undefined, { context: context() }),
		).resolves.toEqual({ state: "accountUsed", remaining: 0, cards: receipt.cardKeys });
	});

	it("gives purchasers repeatable packs without consuming any trial", async () => {
		vi.mocked(auth.api.getSession).mockResolvedValue(session("past-paying-account"));
		vi.mocked(hasPortraitPackPurchase).mockResolvedValue(true);
		const purchase = context();
		const draw = (requestId: string) =>
			call(portraitPacksRouter.open, { requestId }, { context: purchase });
		const pack = await draw(firstRequest);
		expect(pack.state).toBe("unlocked");
		expect(await draw(firstRequest)).toEqual(pack);
		expect((await draw(secondRequest)).cards).not.toEqual(pack.cards);
		expect(issuePortraitPackTrial).not.toHaveBeenCalled();
	});

	it("requires a signed guest browser or a registered account and rejects another origin", async () => {
		vi.mocked(auth.api.getSession).mockResolvedValue(session("anon", true));
		await expect(
			call(
				portraitPacksRouter.open,
				{ requestId: firstRequest },
				{ context: context("ezpic_guest=forged") },
			),
		).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
		await expect(
			call(
				portraitPacksRouter.open,
				{ requestId: firstRequest },
				{ context: context("", "https://external.example") },
			),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
		expect(issuePortraitPackTrial).not.toHaveBeenCalled();
	});
});
