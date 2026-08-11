export function normalizeServiceName(value) {
  return value.trim().toLowerCase().replaceAll("_", "-");
}
