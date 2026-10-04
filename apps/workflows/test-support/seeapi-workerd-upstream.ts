// Independent local Worker for native workerd transport tests. Every request,
// including a mistakenly followed redirect, ends here; there is no network fallback.
export const seeapiUpstream = `
let state;
const taskId = "seeapi_workerd_immutable_1";
function reset(url) {
  state = { postCalls: 0, getCalls: 0, redirectCalls: 0, unexpectedCalls: 0,
    mode: url.searchParams.get("mode") || "queued",
    durationMillis: Number(url.searchParams.get("duration") || 5000), requests: [] };
}
function envelope(status) {
  const count = state.submitted?.input.num_frames || 8;
  return { id: taskId, object: "inference", model: "video-nsfw-filter",
    endpoint: "video-moderation", provider: "seeapi", status, error: null,
    result: status === "succeeded" ? { type: "json", data: { flagged: false, output: {
      nsfw_detected: false, scope: "sampled_frames", sampling_complete: true,
      checked_frames: count, timestamp_source: "frame_index_div_fps_estimate",
      output_layout: "named-files-v1", report_schema_version: 5, flagged_frame_count: 0,
      frames: Array.from({length: count}, (_, index) => ({ frame_number: 1 + index * 17,
        timestamp_seconds: index * state.durationMillis / 1000 / (count - 1),
        nsfw_detected: false, nsfw: [], special: [] }))
    } } } : null };
}
function streamedJson(value, status = 200) {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  let offset = 0;
  return new Response(new ReadableStream({ pull(controller) {
    if (offset === bytes.length) return controller.close();
    const end = Math.min(bytes.length, offset + 19);
    controller.enqueue(bytes.slice(offset, end)); offset = end;
  } }), {status, headers: {"content-type": "application/json"}});
}
export default { async fetch(request) {
  const url = new URL(request.url);
  if (url.origin === "https://seeapi-fixture.invalid" && url.pathname === "/__reset") {
    reset(url); return Response.json({reset: true});
  }
  if (url.origin === "https://seeapi-fixture.invalid" && url.pathname === "/__state")
    return Response.json(state);
  if (url.origin === "https://seeapi-redirect.invalid") {
    state.redirectCalls++; return streamedJson(envelope("succeeded"));
  }
  state.requests.push({method: request.method, url: request.url});
  if (url.origin !== "https://api.seeapi.com") {
    state.unexpectedCalls++; return new Response("Unexpected local origin", {status: 502});
  }
  if (request.method === "POST" && url.pathname === "/v1/inferences") {
    state.postCalls++;
    state.authorization = request.headers.get("authorization");
    state.idempotencyKey = request.headers.get("idempotency-key");
    state.contentType = request.headers.get("content-type");
    const bytes = await request.arrayBuffer();
    state.requestBytes = bytes.byteLength;
    state.submitted = JSON.parse(new TextDecoder().decode(bytes));
    if (state.mode === "post-503") return streamedJson({error: "local fixture unavailable"}, 503);
    if (state.mode === "post-redirect") return new Response(null,
      {status: 307, headers: {location: "https://seeapi-redirect.invalid/paid-target"}});
    if (state.mode === "malformed") return new Response("{", {headers: {"content-type": "application/json"}});
    return streamedJson(envelope(state.mode === "immediate" ? "succeeded" : "queued"), 202);
  }
  if (request.method === "GET" && url.pathname === "/v1/inferences/" + taskId) {
    state.getCalls++;
    if (state.mode === "get-redirect") return new Response(null,
      {status: 308, headers: {location: "https://seeapi-redirect.invalid/query-target"}});
    const result = envelope("succeeded");
    if (state.mode === "wrong-id") result.id = "unrelated_task";
    return streamedJson(result);
  }
  state.unexpectedCalls++;
  return new Response("Unexpected local endpoint or task ID", {status: 502});
} };`;
