import type { ApiFailure } from "../../src/shared/dashboard";
export class ApiError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly status: number,
  ) {
    super(message);
  }
}
export async function request<T>(
  path: string,
  options?: { method: string; body?: unknown; csrf: string },
): Promise<T> {
  const response = await fetch(path, {
    credentials: "same-origin",
    method: options?.method,
    headers: options
      ? { "Content-Type": "application/json", "X-CSRF-Token": options.csrf }
      : undefined,
    body:
      options?.body !== undefined ? JSON.stringify(options.body) : undefined,
  });
  const data: unknown = await response.json();
  if (!response.ok) {
    const failure = data as ApiFailure;
    throw new ApiError(
      failure.code ?? "REQUEST_FAILED",
      failure.message ?? "The request failed. Please try again.",
      response.status,
    );
  }
  return data as T;
}
