import { orpcClient } from "@shared/lib/orpc-client";
import { QueryClient, QueryObserver, type QueryFunction } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@shared/lib/orpc-client", () => ({
	orpcClient: { media: { getCreditAccount: vi.fn() } },
}));

import {
	creditAccountOwnerId,
	creditAccountQueryKey,
	creditAccountQueryOptions,
} from "./credit-account-query";

type CreditAccount = Awaited<ReturnType<typeof orpcClient.media.getCreditAccount>>;
type CreditQuery = QueryFunction<CreditAccount, ReturnType<typeof creditAccountQueryKey>>;

function account(spendableCredits: string): CreditAccount {
	return {
		spendableCredits,
		reservedCredits: "0",
		creditDebt: "0",
		version: 1,
		activeJobs: 0,
		maximumConcurrentJobs: 1,
		maximumInputBytes: 1_000_000,
	};
}

function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

const clients: QueryClient[] = [];
const subscriptions: (() => void)[] = [];
function createClient() {
	const client = new QueryClient({
		defaultOptions: { queries: { retry: false, staleTime: Infinity } },
	});
	clients.push(client);
	return client;
}
const getCreditAccount = vi.mocked(orpcClient.media.getCreditAccount);

describe("owner-scoped credit account queries", () => {
	beforeEach(() => vi.resetAllMocks());
	afterEach(() => {
		for (const unsubscribe of subscriptions.splice(0)) unsubscribe();
		for (const client of clients.splice(0)) client.clear();
	});

	it.each([
		[{ loaded: false, user: null }, null],
		[{ loaded: false, user: { id: "A" } }, null],
		[{ loaded: true, user: null }, null],
		[{ loaded: true, user: { id: "guest", isAnonymous: true } }, null],
		[{ loaded: true, user: { id: "A", isAnonymous: false } }, "A"],
		[{ loaded: true, user: { id: "A", isAnonymous: null } }, "A"],
	] as const)("resolves the ready registered owner for %j", (session, expected) => {
		expect(creditAccountOwnerId(session)).toBe(expected);
	});

	it("does not query before an owner is ready, including an explicit refetch", async () => {
		const client = createClient();
		const options = creditAccountQueryOptions(null);
		const observer = new QueryObserver(client, options);
		subscriptions.push(observer.subscribe(() => undefined));
		expect(observer.getCurrentResult().fetchStatus).toBe("idle");
		expect(getCreditAccount).not.toHaveBeenCalled();
		await expect(client.fetchQuery(options)).rejects.toThrow("A credit account owner is required");
		expect(getCreditAccount).not.toHaveBeenCalled();
	});

	it("clears A's visible balance on switching to B and keeps both caches separate", async () => {
		getCreditAccount.mockResolvedValueOnce(account("100")).mockResolvedValueOnce(account("20"));
		const client = createClient();
		const observer = new QueryObserver(client, creditAccountQueryOptions("A"));
		subscriptions.push(observer.subscribe(() => undefined));
		await observer.refetch({ cancelRefetch: false });
		expect(observer.getCurrentResult().data?.spendableCredits).toBe("100");
		observer.setOptions(creditAccountQueryOptions("B"));
		expect(observer.getCurrentResult().data).toBeUndefined();
		await observer.refetch({ cancelRefetch: false });
		expect(observer.getCurrentResult().data?.spendableCredits).toBe("20");
		expect(client.getQueryData<CreditAccount>(creditAccountQueryKey("A"))?.spendableCredits).toBe(
			"100",
		);
		expect(client.getQueryData<CreditAccount>(creditAccountQueryKey("B"))?.spendableCredits).toBe(
			"20",
		);
		observer.setOptions(creditAccountQueryOptions("A"));
		expect(observer.getCurrentResult().data?.spendableCredits).toBe("100");
		expect(getCreditAccount).toHaveBeenCalledTimes(2);
	});

	it("does not replace B with a late A response even while another A observer stays active", async () => {
		const lateA = deferred<CreditAccount>();
		getCreditAccount.mockReturnValueOnce(lateA.promise).mockResolvedValueOnce(account("20"));
		const client = createClient();
		const retainedA = new QueryObserver(client, creditAccountQueryOptions("A"));
		const observer = new QueryObserver(client, creditAccountQueryOptions("A"));
		subscriptions.push(
			retainedA.subscribe(() => undefined),
			observer.subscribe(() => undefined),
		);
		const aResult = retainedA.refetch({ cancelRefetch: false });
		observer.setOptions(creditAccountQueryOptions("B"));
		await observer.refetch({ cancelRefetch: false });
		expect(getCreditAccount.mock.calls[0][1]?.signal?.aborted).toBe(false);
		lateA.resolve(account("100"));
		await aResult;
		expect(retainedA.getCurrentResult().data?.spendableCredits).toBe("100");
		expect(observer.getCurrentResult().data?.spendableCredits).toBe("20");
		expect(getCreditAccount).toHaveBeenCalledTimes(2);
	});

	it("cancels the old owner's query and discards a transport response that arrives after cancellation", async () => {
		const lateA = deferred<CreditAccount>();
		const finishedA = deferred<void>();
		getCreditAccount.mockReturnValueOnce(lateA.promise).mockResolvedValueOnce(account("20"));
		const client = createClient();
		const options = creditAccountQueryOptions("A");
		const queryFn = options.queryFn as CreditQuery;
		const observer = new QueryObserver(client, {
			...options,
			queryFn: async (context) => {
				try {
					return await queryFn(context);
				} finally {
					finishedA.resolve();
				}
			},
		});
		subscriptions.push(observer.subscribe(() => undefined));
		observer.setOptions(creditAccountQueryOptions("B"));
		expect(getCreditAccount.mock.calls[0][1]?.signal?.aborted).toBe(true);
		await observer.refetch({ cancelRefetch: false });
		lateA.resolve(account("100"));
		await finishedA.promise;
		expect(observer.getCurrentResult().data?.spendableCredits).toBe("20");
		expect(client.getQueryData(creditAccountQueryKey("A"))).toBeUndefined();
		expect(getCreditAccount).toHaveBeenCalledTimes(2);
	});

	it("checks abort after the RPC returns even when its transport ignores cancellation", async () => {
		const late = deferred<CreditAccount>();
		getCreditAccount.mockReturnValueOnce(late.promise);
		const client = createClient();
		const options = creditAccountQueryOptions("A");
		const queryFn = options.queryFn as CreditQuery;
		const controller = new AbortController();
		const result = queryFn({
			client,
			queryKey: options.queryKey,
			signal: controller.signal,
			meta: undefined,
		});
		const rejection = expect(result).rejects.toMatchObject({ name: "AbortError" });
		expect(getCreditAccount).toHaveBeenCalledWith(undefined, { signal: controller.signal });
		controller.abort();
		late.resolve(account("100"));
		await rejection;
		expect(getCreditAccount).toHaveBeenCalledTimes(1);
	});

	it("retains the current owner's balance and reports a failed background refresh", async () => {
		const failure = new Error("credit refresh unavailable");
		getCreditAccount.mockResolvedValueOnce(account("20")).mockRejectedValueOnce(failure);
		const client = createClient();
		const observer = new QueryObserver(client, creditAccountQueryOptions("B"));
		subscriptions.push(observer.subscribe(() => undefined));
		await observer.refetch({ cancelRefetch: false });
		client.setQueryData(creditAccountQueryKey("A"), account("100"));
		await client.invalidateQueries({ queryKey: creditAccountQueryKey("B"), exact: true });
		expect(observer.getCurrentResult()).toMatchObject({
			data: { spendableCredits: "20" },
			error: failure,
			status: "error",
			isRefetchError: true,
			fetchStatus: "idle",
		});
		expect(client.getQueryState(creditAccountQueryKey("A"))?.isInvalidated).toBe(false);
		expect(getCreditAccount).toHaveBeenCalledTimes(2);
	});
});
