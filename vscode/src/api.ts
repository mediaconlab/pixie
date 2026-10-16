/** REST calls to the brain (PROTOCOL.md §1). Uses global fetch; injectable for tests. */
import { normaliseBrainUrl } from "./protocol";

export interface ClaimResult {
  user_id: string;
  device_id: string;
  token: string;
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

type FetchLike = (input: string, init?: { method?: string; headers?: Record<string, string>; body?: string }) => Promise<{
  ok: boolean;
  status: number;
  text(): Promise<string>;
}>;

async function call<T>(fetchFn: FetchLike, url: string, init: Parameters<FetchLike>[1]): Promise<T> {
  let res;
  try {
    res = await fetchFn(url, init);
  } catch (e) {
    throw new ApiError(0, "network_error", `Could not reach Pixie: ${(e as Error).message}`);
  }
  const text = await res.text();
  let body: Record<string, unknown> = {};
  try {
    body = text ? (JSON.parse(text) as Record<string, unknown>) : {};
  } catch {
    /* non-JSON body */
  }
  if (!res.ok) {
    const code = typeof body.error === "string" ? body.error : `http_${res.status}`;
    const message = typeof body.message === "string" ? body.message : code;
    throw new ApiError(res.status, code, message);
  }
  return body as T;
}

export async function claimPairing(
  brainUrl: string,
  code: string,
  deviceName: string,
  fetchFn: FetchLike = fetch as unknown as FetchLike,
): Promise<ClaimResult> {
  const base = normaliseBrainUrl(brainUrl);
  const result = await call<ClaimResult>(fetchFn, `${base}/v1/pair/claim`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ code: code.trim(), device: { kind: "ide", name: deviceName } }),
  });
  if (!result || typeof result.token !== "string" || !result.token) {
    throw new ApiError(200, "bad_response", "Pixie did not return a device token");
  }
  return result;
}

export async function revokeDevice(
  brainUrl: string,
  token: string,
  deviceId: string,
  fetchFn: FetchLike = fetch as unknown as FetchLike,
): Promise<void> {
  const base = normaliseBrainUrl(brainUrl);
  await call(fetchFn, `${base}/v1/devices/${encodeURIComponent(deviceId)}`, {
    method: "DELETE",
    headers: { Authorization: `Bearer ${token}` },
  });
}

export function describeApiError(e: unknown): string {
  if (e instanceof ApiError) {
    if (e.code === "bad_code") return "That pairing code is wrong or has expired. Ask your Mac for a new one.";
    if (e.code === "network_error") return e.message;
    return `Pixie said: ${e.message}`;
  }
  return (e as Error)?.message ?? String(e);
}
