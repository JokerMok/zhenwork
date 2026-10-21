import { createHash } from 'node:crypto';

/** Core's legacy scalar-string adapter is normalized only where schema is unambiguous. */
export function normalizeToolArguments(schema: unknown, value: unknown): unknown {
  if (!schema || typeof schema !== 'object') return value;
  const s = schema as Record<string, unknown>;
  if (s.type === 'boolean' && typeof value === 'string' && /^(true|false)$/i.test(value))
    return value.toLowerCase() === 'true';
  if (s.type === 'integer' && typeof value === 'string' && /^\d{1,7}$/.test(value)) return Number(value);
  if (Array.isArray(value)) return value.map((item) => normalizeToolArguments(s.items, item));
  if (value && typeof value === 'object') {
    const properties = (s.properties || {}) as Record<string, unknown>;
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, normalizeToolArguments(properties[key], item)])
    );
  }
  return value;
}

/** Validate the advertised JSON schema before any side effect; no model coercion. */
export function validateToolArguments(schema: unknown, value: unknown, at = 'arguments'): void {
  if (!schema || typeof schema !== 'object') return;
  const s = schema as Record<string, unknown>;
  const fail = (reason: string): never => {
    throw new Error(`OFFICE_ARGUMENT_INVALID ${at}: ${reason}`);
  };
  const matches = (type: string) =>
    type === 'null'
      ? value === null
      : type === 'array'
        ? Array.isArray(value)
        : type === 'object'
          ? value !== null && typeof value === 'object' && !Array.isArray(value)
          : type === 'integer'
            ? typeof value === 'number' && Number.isSafeInteger(value)
            : typeof value === type;
  const types = Array.isArray(s.type) ? s.type : s.type ? [s.type] : [];
  if (types.length && !types.some((type) => matches(String(type)))) fail('expected ' + types.join('|'));
  if (Array.isArray(s.enum) && !s.enum.includes(value)) fail('expected one of ' + s.enum.join(', '));
  if (typeof value === 'string') {
    if (typeof s.minLength === 'number' && value.length < s.minLength) fail('too short');
    if (typeof s.maxLength === 'number' && value.length > s.maxLength) fail('too long');
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) fail('finite number required');
    if (typeof s.minimum === 'number' && value < s.minimum) fail('below minimum');
    if (typeof s.maximum === 'number' && value > s.maximum) fail('above maximum');
  }
  if (Array.isArray(value)) {
    if (typeof s.minItems === 'number' && value.length < s.minItems) fail('too few items');
    if (typeof s.maxItems === 'number' && value.length > s.maxItems) fail('too many items');
    value.forEach((item, index) => validateToolArguments(s.items, item, `${at}[${index}]`));
  } else if (value && typeof value === 'object') {
    const object = value as Record<string, unknown>;
    for (const key of (s.required as string[] | undefined) || [])
      if (!Object.hasOwn(object, key)) fail(`missing ${key}`);
    const properties = (s.properties || {}) as Record<string, unknown>;
    for (const [key, item] of Object.entries(object)) {
      if (Object.hasOwn(properties, key)) validateToolArguments(properties[key], item, `${at}.${key}`);
      else if (s.additionalProperties === false)
        fail(`unknown ${key}; use documented nested fields (table.headers/table.rows)`);
      else if (s.additionalProperties && typeof s.additionalProperties === 'object')
        validateToolArguments(s.additionalProperties, item, `${at}.${key}`);
    }
    if (Array.isArray(s.oneOf)) {
      const count = s.oneOf.filter((branch) => {
        try {
          validateToolArguments(branch, value, at);
          return true;
        } catch {
          return false;
        }
      }).length;
      if (count !== 1) fail('provide exactly one of quote or quoteIndex');
    }
    if (s.not) {
      let forbidden = false;
      try {
        validateToolArguments(s.not, value, at);
        forbidden = true;
      } catch {
        /* Required field absent. */
      }
      if (forbidden) fail('forbidden field combination');
    }
  }
}

/** Identical invalid calls get no more than three attempts per five-minute window. */
export class InvalidCallBudget {
  private entries = new Map<string, { count: number; until: number }>();
  constructor(private readonly now = Date.now) {}
  private key(conversation: string, tool: string, args: unknown) {
    return createHash('sha256')
      .update(JSON.stringify([conversation, tool, args]))
      .digest('hex');
  }
  check(conversation: string, tool: string, args: unknown): void {
    const entry = this.entries.get(this.key(conversation, tool, args));
    if (entry && entry.until > this.now() && entry.count >= 3)
      throw new Error(
        'OFFICE_CORRECTION_LIMIT: repeated invalid arguments blocked for 5 minutes; re-read schema/sources and change arguments or report partial completion.'
      );
  }
  failed(conversation: string, tool: string, args: unknown): void {
    const now = this.now();
    for (const [key, entry] of this.entries) if (entry.until <= now) this.entries.delete(key);
    while (this.entries.size >= 256) this.entries.delete(this.entries.keys().next().value!);
    const key = this.key(conversation, tool, args),
      entry = this.entries.get(key);
    this.entries.set(key, { count: (entry?.count || 0) + 1, until: entry?.until || now + 300_000 });
  }
}
