import type { PrismaClient } from "../../../generated/client";

function deferred<T>() {
	let resolve!: (value: T | PromiseLike<T>) => void;
	let reject!: (reason?: unknown) => void;
	const promise = new Promise<T>((onResolve, onReject) => {
		resolve = onResolve;
		reject = onReject;
	});
	return { promise, resolve, reject };
}

async function deadline<T>(operation: Promise<T>, label: string): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		return await Promise.race([
			operation,
			new Promise<never>((_resolve, reject) => {
				timer = setTimeout(() => reject(new Error(label)), 2_000);
			}),
		]);
	} finally {
		clearTimeout(timer);
	}
}

/** Real-PG proof: pause one claim at its own job lock, then finish another owner's claim. */
export async function claimAcrossIndependentOwners<T>(input: {
	client: PrismaClient;
	blockedJobId: string;
	blockedClaim: () => Promise<T>;
	independentClaim: () => Promise<T>;
}): Promise<[T, T]> {
	const ready = deferred<number>();
	const release = deferred<void>();
	const blocker = input.client.$transaction(
		async (tx) => {
			await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`video-v1:${input.blockedJobId}`},0))`;
			const [row] = await tx.$queryRaw<Array<{ pid: number }>>`SELECT pg_backend_pid() AS pid`;
			ready.resolve(row!.pid);
			await release.promise;
		},
		{ timeout: 10_000 },
	);
	void blocker.catch(ready.reject);
	let first: Promise<T> | undefined;
	let second: Promise<T> | undefined;
	try {
		const blockingPid = await deadline(ready.promise, "JOB_LOCK_FIXTURE_NOT_READY");
		first = input.blockedClaim();
		void first.catch(() => undefined);
		const until = Date.now() + 2_000;
		let waiting = false;
		while (Date.now() < until) {
			const [row] = await input.client.$queryRaw<Array<{ waiting: boolean }>>`
				SELECT EXISTS (
					SELECT 1 FROM pg_stat_activity
					WHERE ${blockingPid} = ANY(pg_blocking_pids(pid))
				) AS waiting`;
			if (row?.waiting) {
				waiting = true;
				break;
			}
			await new Promise((resolve) => setTimeout(resolve, 5));
		}
		if (!waiting) throw new Error("CLAIM_DID_NOT_REACH_ITS_JOB_LOCK");
		second = input.independentClaim();
		const independent = await deadline(second, "INDEPENDENT_OWNER_CLAIM_BLOCKED_BY_PROVIDER_LOCK");
		release.resolve();
		await blocker;
		return [await first, independent];
	} finally {
		release.resolve();
		await Promise.allSettled([blocker, ...(first ? [first] : []), ...(second ? [second] : [])]);
	}
}
