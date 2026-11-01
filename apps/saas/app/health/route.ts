import { publicHealthResponse } from "../../cloudflare/public-edge";

function health(method: "GET" | "HEAD") {
	const response = publicHealthResponse(new Request("https://ezimageai.com/health", { method }));
	if (!response) throw new Error("HEALTH_RESPONSE_REQUIRED");
	return response;
}

export function GET() {
	return health("GET");
}

export function HEAD() {
	return health("HEAD");
}
