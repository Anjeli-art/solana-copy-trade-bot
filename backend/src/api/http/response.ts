import type { ServerResponse } from "http";
import type { IncomingMessage } from "http";

const allowedOrigins = new Set([
  "http://127.0.0.1:5173",
  "http://localhost:5173"
]);

function getCorsHeaders(origin?: string) {
  const allowOrigin = origin && allowedOrigins.has(origin) ? origin : "*";

  return {
    "Access-Control-Allow-Origin": allowOrigin,
    "Access-Control-Allow-Methods": "GET,POST,PUT,PATCH,DELETE,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Vary": "Origin"
  };
}

export function sendJson(response: ServerResponse, statusCode: number, payload: unknown, request?: IncomingMessage) {
  response.writeHead(statusCode, {
    ...getCorsHeaders(request?.headers.origin),
    "Content-Type": "application/json"
  });
  response.end(JSON.stringify(payload));
}

export function sendNoContent(response: ServerResponse, request?: IncomingMessage) {
  response.writeHead(204, getCorsHeaders(request?.headers.origin));
  response.end();
}

export function sendError(response: ServerResponse, statusCode: number, code: string, message: string, request?: IncomingMessage) {
  sendJson(response, statusCode, {
    error: {
      code,
      message
    }
  }, request);
}
