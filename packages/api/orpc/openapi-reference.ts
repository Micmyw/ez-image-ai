import type { OpenAPIGeneratorGenerateOptions } from "@orpc/openapi";
import { OpenAPIHandler } from "@orpc/openapi/fetch";
import { OpenAPIReferencePlugin } from "@orpc/openapi/plugins";
import { ZodToJsonSchemaConverter } from "@orpc/zod/zod4";
import { auth } from "@repo/auth";

import { apiDocsPath, apiSpecPath } from "./handler-support";
import type { ApiRequestContext } from "./procedures";
import { getOpenApiTitle } from "./product-metadata";
import { router } from "./router";

export function createOpenApiReferenceHandler() {
	const reference = new OpenAPIReferencePlugin<ApiRequestContext>({
		schemaConverters: [new ZodToJsonSchemaConverter()],
		specGenerateOptions: async () => {
			const authSchema = await auth.api.generateOpenAPISchema();
			// Better Auth's OpenAPI 3.1 document uses broader types than the oRPC generator accepts.
			return {
				...authSchema,
				paths: Object.fromEntries(
					Object.entries(authSchema.paths).map(([path, pathItem]) => [`/auth${path}`, pathItem]),
				),
				info: {
					title: getOpenApiTitle(),
					version: "1.0.0",
				},
				servers: [{ url: "/api" }],
			} as unknown as OpenAPIGeneratorGenerateOptions;
		},
		docsPath: apiDocsPath,
		specPath: apiSpecPath,
	});

	// REST routes have already been matched. Generate the reference from the full router.
	return new OpenAPIHandler<ApiRequestContext>(
		{},
		{
			plugins: [{ init: (options) => reference.init(options, router) }],
		},
	);
}
