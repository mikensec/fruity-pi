let csrf = "";

export function setCsrf(token: string | undefined) {
  csrf = token ?? "";
}
export function getCsrf() {
  return csrf;
}

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

let onUnauthorized: () => void = () => {};
export function setUnauthorizedHandler(fn: () => void) {
  onUnauthorized = fn;
}

export async function api<T = any>(method: string, route: string, body?: unknown): Promise<T> {
  const res = await fetch(route, {
    method,
    credentials: "same-origin",
    headers: {
      ...(body !== undefined ? { "content-type": "application/json" } : {}),
      ...(method !== "GET" ? { "x-csrf-token": csrf } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && !route.startsWith("/api/auth/")) onUnauthorized();
  if (!res.ok) throw new ApiError(res.status, data.error ?? `HTTP ${res.status}`);
  return data as T;
}

export const get = <T = any>(r: string) => api<T>("GET", r);
export const post = <T = any>(r: string, b: unknown = {}) => api<T>("POST", r, b);
export const put = <T = any>(r: string, b: unknown = {}) => api<T>("PUT", r, b);
export const del = <T = any>(r: string) => api<T>("DELETE", r);

export function wsUrl(path: string) {
  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  return `${proto}//${location.host}${path}`;
}
