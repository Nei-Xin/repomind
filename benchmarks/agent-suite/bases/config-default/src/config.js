export function requestTimeout(environment = {}) {
  return Number(environment.REQUEST_TIMEOUT_MS ?? 30_000);
}
