import { and, eq, ilike, isNull, or, sql } from "drizzle-orm";
import type { z } from "zod";

import { db } from "../client";
import { account, user } from "../schema/postgres";
import type { UserUpdateSchema } from "../zod";

export async function getUsers({
	limit,
	offset,
	query,
}: {
	limit: number;
	offset: number;
	query?: string;
}) {
	return await db.query.user.findMany({
		where: query
			? (user, { ilike, or }) => or(ilike(user.name, `%${query}%`), ilike(user.email, `%${query}%`))
			: undefined,
		limit,
		offset,
	});
}

export async function countAllUsers({ query }: { query?: string }) {
	const result = await db
		.select({ count: sql<number>`count(*)` })
		.from(user)
		.where(query ? or(ilike(user.name, `%${query}%`), ilike(user.email, `%${query}%`)) : undefined);
	return Number(result[0]?.count ?? 0);
}

export async function getUserById(id: string) {
	return await db.query.user.findFirst({
		where: (user, { eq }) => eq(user.id, id),
	});
}

/** Persist only a server-sanitized registration snapshot; later visits cannot replace it. */
export async function setUserRegistrationAttributionOnce(
	userId: string,
	snapshot: Record<string, unknown>,
): Promise<boolean> {
	const changed = await db
		.update(user)
		.set({ registrationAttribution: snapshot })
		.where(
			and(eq(user.id, userId), eq(user.isAnonymous, false), isNull(user.registrationAttribution)),
		)
		.returning({ id: user.id });
	return changed.length === 1;
}

export async function getUserByEmail(email: string) {
	return await db.query.user.findFirst({
		where: (user, { eq }) => eq(user.email, email),
	});
}

export async function createUser({
	email,
	name,
	role,
	emailVerified,
	onboardingComplete,
}: {
	email: string;
	name: string;
	role: "admin" | "user";
	emailVerified: boolean;
	onboardingComplete: boolean;
}) {
	const [{ id }] = await db
		.insert(user)
		.values({
			email,
			name,
			role,
			emailVerified,
			onboardingComplete,
			createdAt: new Date(),
			updatedAt: new Date(),
		})
		.returning({
			id: user.id,
		});

	const newUser = await getUserById(id);

	return newUser;
}

export async function getAccountById(id: string) {
	return await db.query.account.findFirst({
		where: (account, { eq }) => eq(account.id, id),
	});
}

export async function createUserAccount({
	userId,
	providerId,
	accountId,
	hashedPassword,
}: {
	userId: string;
	providerId: string;
	accountId: string;
	hashedPassword?: string;
}) {
	const [{ id }] = await db
		.insert(account)
		.values({
			userId,
			accountId,
			providerId,
			createdAt: new Date(),
			updatedAt: new Date(),
			password: hashedPassword,
		})
		.returning({
			id: account.id,
		});

	const newAccount = await getAccountById(id);

	return newAccount;
}

export async function updateUser(updatedUser: z.infer<typeof UserUpdateSchema>) {
	const { registrationAttribution: _registrationAttribution, ...mutableUser } = updatedUser;
	return db.update(user).set(mutableUser).where(eq(user.id, updatedUser.id));
}
