import { app } from "@repo/api";
import { runLocalMediaE2ERequest } from "@shared/lib/local-media-e2e-request";
import { handle } from "hono/vercel";

const apiHandler = handle(app);
const handler = (request: Request) => runLocalMediaE2ERequest(request, () => apiHandler(request));

export const GET = handler;
export const POST = handler;
export const PUT = handler;
export const PATCH = handler;
export const DELETE = handler;
export const OPTIONS = handler;
