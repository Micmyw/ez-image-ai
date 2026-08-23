import { and, eq, ilike, or, sql } from "drizzle-orm";
import type { z } from "zod";

import { db } from "../client";
import { member, organization } from "../schema/postgres";
import type { OrganizationUpdateSchema } from "../zod";

export async function getOrganizations({
	limit,
	offset,
	query,
}: {
	limit: number;
	offset: number;
	query?: string;
}) {
	return db.query.organization.findMany({
		where: query ? (org, { ilike, or }) => or(ilike(org.name, `%${query}%`)) : undefined,
		limit,
		offset,
		extras: {
			membersCount:
				sql<number>`(SELECT COUNT(*) FROM ${member} WHERE ${member.organizationId} = ${organization.id})`.as(
					"membersCount",
				),
		},
	});
}

export async function countAllOrganizations({ query }: { query?: string }) {
	const result = await db
		.select({ count: sql<number>`count(*)` })
		.from(organization)
		.where(query ? or(ilike(organization.name, `%${query}%`)) : undefined);
	return Number(result[0]?.count ?? 0);
}

export async function getOrganizationById(id: string) {
	return (
		(await db.query.organization.findFirst({
			where: (org, { eq }) => eq(org.id, id),
			with: {
				members: true,
				invitations: true,
			},
		})) ?? null
	);
}

export async function getInvitationById(id: string) {
	return (
		(await db.query.invitation.findFirst({
			where: (invitation, { eq }) => eq(invitation.id, id),
			with: {
				organization: true,
			},
		})) ?? null
	);
}

export async function getOrganizationBySlug(slug: string) {
	return (
		(await db.query.organization.findFirst({
			where: (org, { eq }) => eq(org.slug, slug),
		})) ?? null
	);
}

export async function getOrganizationMembership(organizationId: string, userId: string) {
	return (
		(await db.query.member.findFirst({
			where: (member, { eq }) =>
				and(eq(member.organizationId, organizationId), eq(member.userId, userId)),
			with: {
				organization: true,
			},
		})) ?? null
	);
}

export async function getOrganizationWithPurchasesAndMembersCount(organizationId: string) {
	return (
		(await db.query.organization.findFirst({
			where: (org, { eq }) => eq(org.id, organizationId),
			with: {
				purchases: true,
			},
			extras: {
				membersCount:
					sql<number>`(SELECT COUNT(*) FROM ${member} WHERE ${member.organizationId} = ${organization.id})`.as(
						"membersCount",
					),
			},
		})) ?? null
	);
}

export async function getPendingInvitationByEmail(email: string) {
	return (
		(await db.query.invitation.findFirst({
			where: (invitation, { eq }) =>
				and(eq(invitation.email, email), eq(invitation.status, "pending")),
		})) ?? null
	);
}

export async function updateOrganization(
	updatedOrganization: z.infer<typeof OrganizationUpdateSchema>,
) {
	return db
		.update(organization)
		.set(updatedOrganization)
		.where(eq(organization.id, updatedOrganization.id));
}
