type AuthClient = (typeof import("@repo/auth/client"))["authClient"];

let loading: Promise<AuthClient> | undefined;

export function loadAuthClient() {
	// Every caller receives the existing Better Auth singleton, including its plugins.
	// A failed chunk request must not prevent a later explicit sign-in attempt.
	loading ??= import("@repo/auth/client")
		.then(({ authClient }) => authClient)
		.catch((error: unknown) => {
			loading = undefined;
			throw error;
		});
	return loading;
}

export function preloadAuthClient() {
	// Intent warms JavaScript only; authentication requests still require submission.
	void loadAuthClient().catch(() => {});
}
