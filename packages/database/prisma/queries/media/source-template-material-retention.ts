import type { Prisma } from "../../generated/client";

// Reserved by the administrator material importer. Published immutable objects
// outlive individual jobs; retiring them requires an explicit material operation.
const MATERIAL_DIRECTORY = "/source-templates/";
export const sourceTemplateMaterialFilter = {
	kind: "INPUT",
	objectKey: { startsWith: "users/", contains: MATERIAL_DIRECTORY },
} satisfies Prisma.MediaAssetWhereInput;

export function isSourceTemplateMaterialObjectKey(objectKey: string): boolean {
	return objectKey.startsWith("users/") && objectKey.includes(MATERIAL_DIRECTORY);
}
