export class ApiError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(code: string, message: string, status: number) {
    super(message);
    this.code = code;
    this.status = status;
    this.name = "ApiError";
  }
}

export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const hasBody = typeof init.body === "string" && init.body.length > 0;
  const headers = new Headers(init.headers);
  if (hasBody && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }
  const res = await fetch(path, {
    ...init,
    credentials: "include",
    headers,
  });
  if (!res.ok) {
    let code = "ERROR";
    let message = `Request failed (${res.status})`;
    try {
      const body = (await res.json()) as {
        error?: { code?: string; message?: string };
        code?: string;
        message?: string;
      };
      message = body.error?.message ?? body.message ?? message;
      code = body.error?.code ?? body.code ?? code;
    } catch {
      // non-JSON error body (e.g. Next dev error page) — keep defaults
    }
    throw new ApiError(code, message, res.status);
  }
  const text = await res.text();
  return (text ? JSON.parse(text) : undefined) as T;
}