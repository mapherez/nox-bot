import { createHttpHandler, createServer } from "@nox/mcp";
import {
  isLegacyRequest,
  WebStandardStreamableHTTPServerTransport,
} from "@modelcontextprotocol/server";

// @nox/mcp v0.4.1 exposes JSON responses in Go, but its TypeScript HTTP
// helper fixes the legacy transport to SSE. Keep NoX's tool runtime and
// modern handler, and compose the SDK's stateless JSON transport for 2025 clients.
export function createJsonHttpHandler(
  options: Parameters<typeof createHttpHandler>[0],
): ReturnType<typeof createHttpHandler> {
  const handler = createHttpHandler(options);
  const active = new Set<() => void>();
  return {
    ...handler,
    async fetch(request, context) {
      if (
        request.method !== "POST" ||
        !(await isLegacyRequest(request, context?.parsedBody))
      )
        return handler.fetch(request, context);

      // The TS SDK requires both Accept values even with enableJsonResponse.
      // JSON clients need not advertise SSE: normalize only this internal
      // request, after confirming that the caller accepts a JSON response.
      if (!acceptsJson(request.headers.get("accept")))
        return Response.json(
          {
            jsonrpc: "2.0",
            id: null,
            error: {
              code: -32000,
              message: "Client must accept application/json.",
            },
          },
          { status: 406 },
        );
      const headers = new Headers(request.headers);
      headers.set("accept", "application/json, text/event-stream");
      const internal = new Request(request, { headers });
      const server = createServer({
        ...options,
        auth: options.resolveAuth?.(context?.authInfo),
      });
      const transport = new WebStandardStreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
        enableJsonResponse: true,
      });
      let cancel!: () => void;
      const cancelled = new Promise<Response>((resolve) => {
        cancel = () => {
          // Closing the SDK cancels tool signals, but its pending JSON response
          // is not resolved on close. Release the HTTP exchange independently.
          void server.close();
          resolve(new Response(null, { status: 499 }));
        };
      });
      try {
        await server.connect(transport);
        active.add(cancel);
        request.signal.addEventListener("abort", cancel, { once: true });
        if (request.signal.aborted) {
          cancel();
          return await cancelled;
        }
        return await Promise.race([
          transport.handleRequest(internal, context),
          cancelled,
        ]);
      } finally {
        active.delete(cancel);
        request.signal.removeEventListener("abort", cancel);
        await server.close();
      }
    },
    async close() {
      for (const cancel of active) cancel();
      await handler.close();
    },
  };
}

function acceptsJson(accept: string | null): boolean {
  if (!accept) return true;
  // More specific media ranges override wildcards, including explicit q=0.
  let best = -1;
  let quality = 0;
  for (const range of accept.toLowerCase().split(",")) {
    const [media, ...parameters] = range.trim().split(";");
    const specificity = ["*/*", "application/*", "application/json"].indexOf(
      media.trim(),
    );
    if (specificity < 0 || specificity < best) continue;
    const weight = parameters.find((parameter) =>
      parameter.trim().startsWith("q="),
    );
    const q = weight ? Number(weight.trim().slice(2)) : 1;
    if (specificity > best) quality = 0;
    best = specificity;
    if (Number.isFinite(q) && q >= 0 && q <= 1) quality = Math.max(quality, q);
  }
  return quality > 0;
}
