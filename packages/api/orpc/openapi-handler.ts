import { onError } from "@orpc/client";
import { SmartCoercionPlugin } from "@orpc/json-schema";
import { OpenAPIHandler } from "@orpc/openapi/fetch";
import { ZodToJsonSchemaConverter } from "@orpc/zod/zod4";
import { logger } from "@repo/logs";

import { safeRpcError } from "./handler-support";
import { router } from "./router";

export function createOpenApiHandler() {
	return new OpenAPIHandler(router, {
		plugins: [
			new SmartCoercionPlugin({
				schemaConverters: [new ZodToJsonSchemaConverter()],
			}),
		],
		clientInterceptors: [
			onError((error) => {
				logger.error("OpenAPI request failed", safeRpcError(error));
			}),
		],
	});
}
