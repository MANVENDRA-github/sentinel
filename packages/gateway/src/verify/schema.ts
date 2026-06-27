/**
 * A minimal, deterministic structural validator for a documented JSON-Schema subset:
 * `type`, `required`, `properties` (recursive), and array `items`. It is intentionally
 * not a full JSON-Schema implementation — enough to confirm a model's JSON output has
 * the requested shape. Throws on a schema it cannot interpret (caller treats that as a
 * fail-closed block).
 */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function matchesType(value: unknown, type: string): boolean {
  switch (type) {
    case 'string':
      return typeof value === 'string';
    case 'number':
      return typeof value === 'number';
    case 'integer':
      return typeof value === 'number' && Number.isInteger(value);
    case 'boolean':
      return typeof value === 'boolean';
    case 'null':
      return value === null;
    case 'array':
      return Array.isArray(value);
    case 'object':
      return isPlainObject(value);
    default:
      throw new Error(`unsupported json schema type "${type}"`);
  }
}

/** Returns whether `value` structurally satisfies `schema`. Throws on an unusable schema. */
export function validateAgainstSchema(value: unknown, schema: unknown): boolean {
  if (!isPlainObject(schema)) {
    throw new Error('json schema must be an object');
  }

  const type = schema.type;
  if (typeof type === 'string' && !matchesType(value, type)) return false;

  if (isPlainObject(value)) {
    const required = schema.required;
    if (Array.isArray(required)) {
      for (const key of required) {
        if (typeof key === 'string' && !(key in value)) return false;
      }
    }
    const properties = schema.properties;
    if (isPlainObject(properties)) {
      for (const [key, subSchema] of Object.entries(properties)) {
        if (key in value && !validateAgainstSchema(value[key], subSchema)) return false;
      }
    }
  }

  if (Array.isArray(value) && isPlainObject(schema.items)) {
    for (const item of value) {
      if (!validateAgainstSchema(item, schema.items)) return false;
    }
  }

  return true;
}
