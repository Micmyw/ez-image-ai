import { useQuery } from "@tanstack/react-query";

export const sessionQueryKey = ["user", "session"] as const;

export async function fetchSession() {
	const { authClient } = await import("@repo/auth/client");
	const { data, error } = await authClient.getSession({
		query: { disableCookieCache: true },
	});
	if (error) throw new Error(error.message || "Failed to fetch session");
	return data;
}

export const useSessionQuery = () => {
	return useQuery({
		queryKey: sessionQueryKey,
		queryFn: fetchSession,
		staleTime: Number.POSITIVE_INFINITY,
		refetchOnWindowFocus: false,
		retry: false,
	});
};

export const userAccountQueryKey = ["user", "accounts"] as const;
export const useUserAccountsQuery = () => {
	return useQuery({
		queryKey: userAccountQueryKey,
		queryFn: async () => {
			const { authClient } = await import("@repo/auth/client");
			const { data, error } = await authClient.listAccounts();

			if (error) {
				throw error;
			}

			return data;
		},
	});
};

export const userPasskeyQueryKey = ["user", "passkeys"] as const;
export const listUserPasskeys = async () => {
	const { authClient } = await import("@repo/auth/client");
	const { data, error } = await authClient.passkey.listUserPasskeys();

	if (error) {
		throw error;
	}

	return data ?? [];
};

export const useUserPasskeysQuery = () => {
	return useQuery({
		queryKey: userPasskeyQueryKey,
		queryFn: listUserPasskeys,
	});
};
