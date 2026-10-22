import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ useQuery: vi.fn(), queryOptions: vi.fn(), visible: true }));
vi.mock("@tanstack/react-query", () => ({ useQuery: mocks.useQuery }));
vi.mock("@shared/lib/orpc-query-utils", () => ({
	orpc: { media: { getTemporaryReferenceStatus: { queryOptions: mocks.queryOptions } } },
}));
vi.mock("./use-page-visible", () => ({ usePageVisible: () => mocks.visible }));

import { useTemporaryReferenceStatus } from "./use-temporary-reference-status";

const reference = {
	assetId: "reference",
	token: "signed-reference",
	expiresAt: new Date(Date.now() + 60000).toISOString(),
};
describe("owner-scoped temporary reference status poll", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mocks.visible = true;
		mocks.queryOptions.mockImplementation(({ input }) => ({
			queryKey: ["temporary-reference", input],
			queryFn: vi.fn(),
		}));
	});
	it("binds cached status to the current owner and exact signed reference", () => {
		useTemporaryReferenceStatus({ ownerId: "owner-a", reference, enabled: true });
		const a = mocks.useQuery.mock.calls.at(-1)![0];
		useTemporaryReferenceStatus({ ownerId: "owner-b", reference, enabled: true });
		const b = mocks.useQuery.mock.calls.at(-1)![0];
		expect(a.queryKey).not.toEqual(b.queryKey);
		expect(a.queryKey).toContainEqual({ assetId: reference.assetId, token: reference.token });
		expect(a).toMatchObject({ enabled: true, retry: false, staleTime: 0, gcTime: 0 });
	});
	it.each(["hidden", "expired", "signed-out", "missing"])(
		"does not poll a %s reference",
		(reason) => {
			mocks.visible = reason !== "hidden";
			useTemporaryReferenceStatus({
				ownerId: reason === "signed-out" ? null : "owner",
				reference: reason === "missing" ? undefined : reference,
				enabled: reason !== "expired",
			});
			const options = mocks.useQuery.mock.calls.at(-1)![0];
			expect(options.enabled).toBe(false);
			expect(options.refetchInterval({ state: { data: { status: "PENDING" } } })).toBe(false);
		},
	);
});
