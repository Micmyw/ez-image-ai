import { z } from "zod";

import { isAdminOperationAllowed } from "./auth";
import { adminOperations } from "./catalog";
import type { AdminActor, AdminOperation } from "./types";

export function availableAdminOperations(actor: AdminActor, operations = adminOperations) {
	return operations.filter((operation) => isAdminOperationAllowed(actor, operation));
}

export function adminOperationDescriptor(operation: AdminOperation) {
	const { $schema: _schema, ...inputSchema } = z.toJSONSchema(operation.inputSchema, {
		io: "input",
	});
	return {
		name: operation.name,
		description: operation.description,
		permission: operation.permission,
		readOnly: operation.readOnly,
		method: operation.method,
		path: operation.path,
		inputSchema: inputSchema as Record<string, unknown>,
	};
}

export function adminOperationCatalog(actor: AdminActor, operations = adminOperations) {
	return {
		operations: availableAdminOperations(actor, operations).map(adminOperationDescriptor),
		permissions: actor.permissions,
		scope: actor.scope,
	};
}

export function adminOpenApi(actor: AdminActor, operations = adminOperations) {
	const paths: Record<string, Record<string, unknown>> = {};
	for (const operation of availableAdminOperations(actor, operations)) {
		const schema = adminOperationDescriptor(operation).inputSchema;
		const properties = (schema.properties ?? {}) as Record<string, Record<string, unknown>>;
		const required = (schema.required ?? []) as string[];
		const parameters: unknown[] =
			operation.method === "GET"
				? Object.entries(properties).map(([name, value]) => ({
						in: "query",
						name,
						required: required.includes(name),
						...(value.type === "object" || value.anyOf || value.oneOf
							? { content: { "application/json": { schema: value } } }
							: { schema: value }),
					}))
				: [];
		if (!operation.readOnly)
			parameters.push({
				in: "header",
				name: "Idempotency-Key",
				required: true,
				schema: { type: "string", pattern: "^[A-Za-z0-9_.:-]{8,128}$" },
				description:
					"Required for every write, including browser sessions. Keep the same key and input on retries.",
			});
		(paths[operation.path] ??= {})[operation.method.toLowerCase()] = {
			operationId: operation.name,
			summary: operation.description,
			"x-required-permission": operation.permission,
			parameters,
			...(operation.method === "GET"
				? {}
				: {
						requestBody: { required: true, content: { "application/json": { schema } } },
					}),
			responses: {
				"200": {
					description:
						"Execution receipt. Domain result distinguishes acceptance, processing and completion.",
					content: {
						"application/json": {
							schema: {
								type: "object",
								required: ["executionId", "replayed", "result"],
								properties: {
									executionId: { type: "string" },
									replayed: { type: "boolean" },
									result: {},
								},
							},
						},
					},
				},
				"400": { description: "Invalid input" },
				"401": { description: "Invalid, expired or revoked credential" },
				"403": { description: "Permission or scope denied" },
				"409": {
					description:
						"Conflicting input, pending execution or uncertain outcome; inspect before another write",
				},
				"503": { description: "Unavailable read or uncertain write outcome" },
			},
		};
	}
	return {
		openapi: "3.1.0",
		info: { title: "EzPic controlled administration", version: "1.0.0" },
		security: [{ adminToken: [] }],
		components: {
			securitySchemes: {
				adminToken: {
					type: "http",
					scheme: "bearer",
					description: "An expiring ez_admin_ service-account key. No OAuth flow is implemented.",
				},
			},
		},
		paths,
	};
}
