/** True for a plain object: not null and not an array. */
export function isPlainObject(value: unknown): value is Record<string, any> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * The input of a tool call is always an object. A model can still send something else (an array, a number, a string,
 * null); that becomes an empty object, so tool handlers never receive a value of the wrong shape.
 */
export function toolInput(value: unknown): Record<string, any> {
  return isPlainObject(value) ? value : {};
}
