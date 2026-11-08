/** A reversible model-facing JSON view. It neither selects nor edits medical evidence. */
export type SummaryJSONValue = null | boolean | number | string | SummaryJSONValue[] | { [key: string]: SummaryJSONValue };
export interface SummarySourceFragment {
  block_id: string;
  text_version: string;
  start: number;
  end: number;
  exact_quote: string;
  occurrence: number;
  physical_page: number;
  bbox: number[];
  location_precision: 'whole_textline_not_exact_glyph';
}
export interface SummaryModelContextPacket {
  encoding: 's4-source-fragment-dictionary-1';
  source_fragment_table: Array<{ ref: string; value: SummarySourceFragment }>;
  context: SummaryJSONValue;
}
export class SummaryModelContextError extends Error {
  constructor(readonly code: string) { super(code); this.name = 'SummaryModelContextError'; }
}

const encoding = 's4-source-fragment-dictionary-1' as const;
const referenceKey = '$source_fragment_ref';
const literalKey = '$source_fragment_literal';
const fragmentKeys = ['bbox', 'block_id', 'end', 'exact_quote', 'location_precision', 'occurrence', 'physical_page', 'start', 'text_version'];
const plain = (value: object) => Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null;
const object = (value: SummaryJSONValue): value is { [key: string]: SummaryJSONValue } => value !== null && typeof value === 'object' && !Array.isArray(value);
const keysEqual = (value: object, keys: string[]) => {
  const actual = Object.keys(value).sort();
  return actual.length === keys.length && actual.every((key, index) => key === keys[index]);
};
const fail = (code: string): never => { throw new SummaryModelContextError(code); };
function setOwn(target: { [key: string]: SummaryJSONValue }, key: string, value: SummaryJSONValue) {
  Object.defineProperty(target, key, { value, enumerable: true, configurable: true, writable: true });
}

/** Strict JSON values only: sort object keys, normalize -0 to 0, never invoke getters or toJSON. */
function normalizeJSON(value: unknown, active = new WeakSet<object>()): SummaryJSONValue {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return fail('summary_context_nonfinite_number');
    return Object.is(value, -0) ? 0 : value;
  }
  if (typeof value !== 'object') return fail('summary_context_not_json');
  if (active.has(value)) return fail('summary_context_cyclic_json');
  if (!Array.isArray(value) && !plain(value)) return fail('summary_context_nonplain_object');
  active.add(value);
  try {
    if (Array.isArray(value)) {
      if (Reflect.ownKeys(value).length !== value.length + 1) return fail('summary_context_non_json_array');
      const result: SummaryJSONValue[] = [];
      for (let index = 0; index < value.length; index++) {
        const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
        if (!descriptor || !('value' in descriptor)) return fail('summary_context_non_json_array');
        result.push(normalizeJSON(descriptor.value, active));
      }
      return result;
    }
    const result: { [key: string]: SummaryJSONValue } = {};
    for (const key of Reflect.ownKeys(value).sort((a, b) => String(a) < String(b) ? -1 : String(a) > String(b) ? 1 : 0)) {
      if (typeof key !== 'string') return fail('summary_context_symbol_key');
      const descriptor = Object.getOwnPropertyDescriptor(value, key)!;
      if (!descriptor.enumerable || !('value' in descriptor)) return fail('summary_context_non_json_property');
      setOwn(result, key, normalizeJSON(descriptor.value, active));
    }
    return result;
  } finally { active.delete(value); }
}

function isFragment(value: SummaryJSONValue): value is SummarySourceFragment & { [key: string]: SummaryJSONValue } {
  if (!object(value) || !keysEqual(value, fragmentKeys)) return false;
  return typeof value.block_id === 'string' && value.block_id.length > 0 && typeof value.text_version === 'string' && value.text_version.length > 0 &&
    typeof value.start === 'number' && Number.isInteger(value.start) && value.start >= 0 &&
    typeof value.end === 'number' && Number.isInteger(value.end) && value.end > value.start &&
    typeof value.exact_quote === 'string' && value.exact_quote.length > 0 &&
    typeof value.occurrence === 'number' && Number.isInteger(value.occurrence) && value.occurrence >= 0 &&
    typeof value.physical_page === 'number' && Number.isInteger(value.physical_page) && value.physical_page >= 1 &&
    Array.isArray(value.bbox) && value.bbox.length === 4 && value.bbox.every(n => typeof n === 'number' && Number.isFinite(n)) &&
    value.location_precision === 'whole_textline_not_exact_glyph';
}

/** No strings are parsed. Original objects using a reserved marker key are escaped as ordered key/value pairs. */
export function packSummaryModelContext(value: unknown): SummaryModelContextPacket {
  const normalized = normalizeJSON(value);
  const table: SummaryModelContextPacket['source_fragment_table'] = [];
  const refs = new Map<string, string>();
  const encode = (item: SummaryJSONValue): SummaryJSONValue => {
    if (isFragment(item)) {
      const canonical = JSON.stringify(item);
      let ref = refs.get(canonical);
      if (!ref) { ref = `sf-${table.length + 1}`; refs.set(canonical, ref); table.push({ ref, value: item }); }
      return { [referenceKey]: ref };
    }
    if (Array.isArray(item)) return item.map(encode);
    if (!object(item)) return item;
    if (Object.hasOwn(item, referenceKey) || Object.hasOwn(item, literalKey)) {
      return { [literalKey]: Object.entries(item).map(([key, child]) => [key, encode(child)]) };
    }
    const result: { [key: string]: SummaryJSONValue } = {};
    for (const [key, child] of Object.entries(item)) setOwn(result, key, encode(child));
    return result;
  };
  const context = encode(normalized);
  return { encoding, source_fragment_table: table, context };
}

/** Reject malformed packets/references. Every expanded occurrence is an independent JSON copy. */
export function unpackSummaryModelContext(packet: unknown): SummaryJSONValue {
  const normalized = normalizeJSON(packet);
  if (!object(normalized) || !keysEqual(normalized, ['context', 'encoding', 'source_fragment_table']) || normalized.encoding !== encoding ||
    !Array.isArray(normalized.source_fragment_table)) return fail('summary_packet_invalid');
  const table = new Map<string, SummarySourceFragment & { [key: string]: SummaryJSONValue }>();
  for (const entry of normalized.source_fragment_table) {
    if (!object(entry) || !keysEqual(entry, ['ref', 'value']) || typeof entry.ref !== 'string' || !/^sf-[1-9][0-9]*$/u.test(entry.ref) ||
      !isFragment(entry.value!)) return fail('summary_fragment_table_invalid');
    if (table.has(entry.ref)) return fail('summary_fragment_reference_duplicate');
    table.set(entry.ref, entry.value);
  }
  const used = new Set<string>();
  const decode = (item: SummaryJSONValue): SummaryJSONValue => {
    if (Array.isArray(item)) return item.map(decode);
    if (!object(item)) return item;
    if (Object.hasOwn(item, referenceKey)) {
      if (!keysEqual(item, [referenceKey]) || typeof item[referenceKey] !== 'string' || !/^sf-[1-9][0-9]*$/u.test(item[referenceKey])) {
        return fail('summary_fragment_reference_invalid');
      }
      const ref = item[referenceKey], fragment = table.get(ref);
      if (!fragment) return fail('summary_fragment_reference_missing');
      used.add(ref); return normalizeJSON(fragment);
    }
    if (Object.hasOwn(item, literalKey)) {
      if (!keysEqual(item, [literalKey]) || !Array.isArray(item[literalKey])) return fail('summary_literal_escape_invalid');
      const result: { [key: string]: SummaryJSONValue } = {};
      for (const pair of item[literalKey]) {
        if (!Array.isArray(pair) || pair.length !== 2 || typeof pair[0] !== 'string' || Object.hasOwn(result, pair[0])) {
          return fail('summary_literal_escape_invalid');
        }
        setOwn(result, pair[0], decode(pair[1]!));
      }
      return result;
    }
    const result: { [key: string]: SummaryJSONValue } = {};
    for (const [key, child] of Object.entries(item)) setOwn(result, key, decode(child));
    return result;
  };
  const result = decode(normalized.context!);
  if (used.size !== table.size) return fail('summary_fragment_table_unreferenced');
  return result;
}
