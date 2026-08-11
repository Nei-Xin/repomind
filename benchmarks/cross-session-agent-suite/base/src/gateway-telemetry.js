export function gatewayRetryTelemetry(headers) {
  const limit = headers["x-gateway-retry-limit"];
  const attempt = headers["x-gateway-retry-attempt"];
  const requestId = headers["x-request-id"];
  if (typeof limit !== "string" || !/^(?:0|[1-9][0-9]*)$/u.test(limit)) {
    throw new TypeError("gateway retry limit header must be a decimal string");
  }
  if (typeof attempt !== "string" || !/^(?:0|[1-9][0-9]*)$/u.test(attempt)) {
    throw new TypeError("gateway retry attempt header must be a decimal string");
  }
  if (typeof requestId !== "string") throw new TypeError("request id header must be a string");
  return {
    policy: headers["x-gateway-retry-policy"],
    limit: Number(limit),
    attempt: Number(attempt),
    requestId,
  };
}
