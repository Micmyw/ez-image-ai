import type { FetchHandler } from "@orpc/server/fetch";

import { apiDocsPath, apiSpecPath, initializeOnce } from "./handler-support";
import type { ApiRequestContext } from "./procedures";

const getRpcHandler = initializeOnce(async () =>
	(await import("./rpc-handler")).createRpcHandler(),
);
const getOpenApiHandler = initializeOnce(async () =>
	(await import("./openapi-handler")).createOpenApiHandler(),
);
const getOpenApiReferenceHandler = initializeOnce(async () =>
	(await import("./openapi-reference")).createOpenApiReferenceHandler(),
);

type ApiHandler = Pick<FetchHandler<ApiRequestContext>, "handle">;

export const rpcHandler: ApiHandler = {
	async handle(request, options) {
		return (await getRpcHandler()).handle(request, options);
	},
};

export const openApiHandler: ApiHandler = {
	async handle(request, options) {
		const result = await (await getOpenApiHandler()).handle(request, options);
		if (result.matched || request.method !== "GET") return result;

		const pathname = new URL(request.url).pathname.replace(/\/$/, "");
		const prefix = options.prefix?.replace(/\/$/, "") ?? "";
		if (pathname !== `${prefix}${apiDocsPath}` && pathname !== `${prefix}${apiSpecPath}`) {
			return result;
		}

		return (await getOpenApiReferenceHandler()).handle(request, options);
	},
};
