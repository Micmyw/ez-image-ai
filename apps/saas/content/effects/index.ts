import "server-only";
import type { Effect } from "../../modules/effects/lib/types";
import { eightiesPhotoEffect } from "./1980s-ai-photo";

/** Register new content here. Every public surface reads the same validated publication view. */
export const effectRecords: readonly Effect[] = [eightiesPhotoEffect];
