export function stringifyCliJson(value: unknown): string {
  return JSON.stringify(value, null, 2).replace(/[\u007f-\uffff]/g, (character) =>
    `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`,
  );
}
