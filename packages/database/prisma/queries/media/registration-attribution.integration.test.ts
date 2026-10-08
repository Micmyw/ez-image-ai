import { PrismaPg } from "@prisma/adapter-pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { PrismaClient } from "../../generated/client";
import { setUserRegistrationAttributionOnce } from "../users";

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const RUN_ID = crypto.randomUUID();
const registeredAt = "2026-10-08T12:00:00.000Z";
const snapshot = {
	version: 1,
	landingPath: "/blog/portrait-ideas",
	referrerOrigin: "https://www.google.com",
	source: "campaign",
	utmSource: "search",
	utmMedium: "organic",
	utmCampaign: "portrait",
	capturedAt: "2026-10-08T11:50:00.000Z",
	registeredAt,
};

describe("immutable registration attribution", () => {
	let client: PrismaClient;
	const userIds: string[] = [];

	beforeAll(() => {
		if (!TEST_DATABASE_URL)
			throw new Error("BLOCKED_BY_ENVIRONMENT: TEST_DATABASE_URL is required");
		const url = new URL(TEST_DATABASE_URL);
		if (
			!["127.0.0.1", "localhost"].includes(url.hostname) ||
			!/(?:test|testing)/i.test(url.pathname) ||
			TEST_DATABASE_URL === process.env.DATABASE_URL
		)
			throw new Error(
				"UNSAFE_TEST_DATABASE: expected a separate disposable loopback test database",
			);
		client = new PrismaClient({
			adapter: new PrismaPg({ connectionString: TEST_DATABASE_URL }),
		});
	});

	afterAll(async () => {
		if (!client) return;
		await client.user.deleteMany({ where: { id: { in: userIds } } });
		await client.$disconnect();
	});

	async function createUser(label: string, isAnonymous = false) {
		const id = `registration-${label}-${RUN_ID}`;
		userIds.push(id);
		return client.user.create({
			data: {
				id,
				name: "Attribution Test",
				email: `${id}@example.test`,
				emailVerified: true,
				isAnonymous,
				createdAt: new Date(registeredAt),
				updatedAt: new Date(registeredAt),
			},
		});
	}

	it("stores the signup source once and preserves it after later visits", async () => {
		const user = await createUser("first");
		expect(await setUserRegistrationAttributionOnce(user.id, snapshot, client)).toBe(true);
		expect(
			await setUserRegistrationAttributionOnce(
				user.id,
				{ ...snapshot, landingPath: "/pricing", utmSource: "later" },
				client,
			),
		).toBe(false);
		expect(
			(await client.user.findUniqueOrThrow({ where: { id: user.id } })).registrationAttribution,
		).toEqual(snapshot);
	});

	it("leaves guests empty and permits their registered conversion to claim its snapshot", async () => {
		const guest = await createUser("guest", true);
		expect(await setUserRegistrationAttributionOnce(guest.id, snapshot, client)).toBe(false);
		expect(
			(await client.user.findUniqueOrThrow({ where: { id: guest.id } })).registrationAttribution,
		).toBeNull();
		await client.user.update({ where: { id: guest.id }, data: { isAnonymous: false } });
		expect(await setUserRegistrationAttributionOnce(guest.id, snapshot, client)).toBe(true);
	});

	it("atomically chooses one concurrent registration snapshot without cross-account writes", async () => {
		const first = await createUser("concurrent");
		const other = await createUser("other");
		const secondSnapshot = { ...snapshot, landingPath: "/create" };
		const results = await Promise.all([
			setUserRegistrationAttributionOnce(first.id, snapshot, client),
			setUserRegistrationAttributionOnce(first.id, secondSnapshot, client),
		]);
		expect(results.filter(Boolean)).toHaveLength(1);
		expect([snapshot, secondSnapshot]).toContainEqual(
			(await client.user.findUniqueOrThrow({ where: { id: first.id } })).registrationAttribution,
		);
		expect(
			(await client.user.findUniqueOrThrow({ where: { id: other.id } })).registrationAttribution,
		).toBeNull();
		expect(await setUserRegistrationAttributionOnce(`missing-${RUN_ID}`, snapshot, client)).toBe(
			false,
		);
	});

	it("preserves an explicit unknown registration and leaves historical rows empty", async () => {
		const current = await createUser("unknown");
		const historical = await createUser("historical");
		const unknown = {
			...snapshot,
			landingPath: null,
			referrerOrigin: null,
			source: "unknown",
			utmSource: null,
			utmMedium: null,
			utmCampaign: null,
		};
		expect(await setUserRegistrationAttributionOnce(current.id, unknown, client)).toBe(true);
		expect(await setUserRegistrationAttributionOnce(current.id, snapshot, client)).toBe(false);
		expect(
			(await client.user.findUniqueOrThrow({ where: { id: current.id } })).registrationAttribution,
		).toEqual(unknown);
		expect(
			(await client.user.findUniqueOrThrow({ where: { id: historical.id } }))
				.registrationAttribution,
		).toBeNull();
	});
});
