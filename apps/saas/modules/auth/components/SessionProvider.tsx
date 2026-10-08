"use client";
import { fetchSession, sessionQueryKey, useSessionQuery } from "@auth/lib/api";
import { syncPurchaseAttributionIdentity } from "@shared/lib/purchase-attribution";
import { useQueryClient } from "@tanstack/react-query";
import { type ReactNode, useEffect, useState } from "react";

import { SessionContext } from "../lib/session-context";

export function SessionProvider({ children }: { children: ReactNode }) {
	const queryClient = useQueryClient();

	const { data: session, isSuccess } = useSessionQuery();
	const [loaded, setLoaded] = useState(!!session);

	useEffect(() => {
		if (session && !loaded) {
			setLoaded(true);
		}
	}, [session]); // oxlint-disable-line eslint-plugin-react-hooks/exhaustive-deps

	useEffect(() => {
		if (isSuccess) syncPurchaseAttributionIdentity(session?.user ?? null);
	}, [session, isSuccess]);

	return (
		<SessionContext.Provider
			value={{
				loaded,
				session: session?.session ?? null,
				user: session?.user ?? null,
				reloadSession: async () => {
					const newSession = await fetchSession();
					queryClient.setQueryData(sessionQueryKey, () => newSession);
				},
			}}
		>
			{children}
		</SessionContext.Provider>
	);
}
