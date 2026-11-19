import { onError } from "@orpc/client";
import { RPCHandler } from "@orpc/server/fetch";
import { logger } from "@repo/logs";

import { safeRpcError } from "./handler-support";
import { router } from "./router";

export function createRpcHandler() {
	return new RPCHandler(router, {
		clientInterceptors: [
			onError((error) => {
				logger.error("oRPC request failed", safeRpcError(error));
			}),
		],
	});
}
