const delivered = new Set();

export async function deliverOnce(id, send) {
  await send(id);
  delivered.add(id);
  return true;
}

export function resetDeliveries() {
  delivered.clear();
}
