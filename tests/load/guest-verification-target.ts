/** Explicit disposable database for suites that truncate their test fixtures. */
export function isExplicitGuestVerificationTarget(target: URL): boolean {
	const approved = process.env.GUEST_TEST_DATABASE_URL;
	if (!approved) return false;
	try {
		return (
			["postgres:", "postgresql:"].includes(target.protocol) &&
			["127.0.0.1", "localhost"].includes(target.hostname) &&
			target.port === "55440" &&
			target.pathname === "/ai_media_guest_test" &&
			!target.search &&
			!target.hash &&
			target.href === new URL(approved).href
		);
	} catch {
		return false;
	}
}
