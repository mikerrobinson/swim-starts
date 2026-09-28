const DEVICE_COOKIE = "mr_timer_id";

/**
 * Who this phone says it is, if it has been here before.
 *
 * `null` for a browser carrying no device cookie, which the callers treat as
 * something to put right rather than as an answer — see `deviceId`.
 */
export function existingDeviceId(request: Request): string | null {
  const jar = request.headers.get("cookie") ?? "";
  for (const part of jar.split(";")) {
    const [name, ...rest] = part.trim().split("=");
    if (name === DEVICE_COOKIE && rest.length) {
      const existing = decodeURIComponent(rest.join("=")).trim();
      if (/^[A-Za-z0-9_-]{1,40}$/.test(existing)) return existing;
    }
  }
  return null;
}

/**
 * Who this phone is when it takes a time.  Assigned when the code is scanned and kept in a cookie.
 */
export function deviceId(request: Request): string {
  // URL-safe, for the sake of anything that still puts it in one.
  return (
    existingDeviceId(request) ?? `d-${Math.random().toString(36).slice(2, 10)}`
  );
}

export function deviceCookie(id: string, request: Request): string {
  const https = new URL(request.url).protocol === "https:";
  return [
    `${DEVICE_COOKIE}=${encodeURIComponent(id)}`,
    `Path=/`,
    "SameSite=Lax",
    ...(https ? ["Secure"] : []),
    `Max-Age=${60 * 60 * 24 * 365}`,
  ].join("; ");
}
