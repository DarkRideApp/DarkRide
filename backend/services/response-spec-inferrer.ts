export interface InferredField {
  type: string | string[];
  required: boolean;
  examples?: any[];
  min?: number;
  max?: number;
  properties?: Record<string, InferredField>;
  items?: InferredField;
}

function inferFromValues(values: any[], totalCount: number): InferredField {
  const types = new Set<string>();
  const examples: any[] = [];
  let min = Infinity;
  let max = -Infinity;
  const objectFields = new Map<string, any[]>();
  const arrayItems: any[] = [];
  let presentCount = 0;
  let objectCount = 0;

  for (const val of values) {
    if (val === null || val === undefined) {
      types.add('null');
      continue;
    }
    presentCount++;

    if (Array.isArray(val)) {
      types.add('array');
      arrayItems.push(...val);
    } else if (typeof val === 'object') {
      types.add('object');
      objectCount++;
      for (const [k, v] of Object.entries(val)) {
        if (!objectFields.has(k)) objectFields.set(k, []);
        objectFields.get(k)!.push(v);
      }
    } else if (typeof val === 'number') {
      types.add('number');
      if (val < min) min = val;
      if (val > max) max = val;
    } else if (typeof val === 'boolean') {
      types.add('boolean');
    } else if (typeof val === 'string') {
      types.add('string');
      if (examples.length < 3 && !examples.includes(val) && val.length < 100) {
        examples.push(val);
      }
    }
  }

  const typeArray = [...types];
  const result: InferredField = {
    type: typeArray.length === 1 ? typeArray[0] : typeArray,
    required: presentCount === totalCount,
  };

  if (types.has('string') && examples.length > 0) {
    result.examples = examples;
  }
  if (types.has('number') && min !== Infinity) {
    result.min = min;
    result.max = max;
  }
  if (types.has('object') && objectFields.size > 0) {
    result.properties = {};
    for (const [key, vals] of objectFields) {
      result.properties[key] = inferFromValues(vals, objectCount);
    }
  }
  if (types.has('array') && arrayItems.length > 0) {
    result.items = inferFromValues(arrayItems, arrayItems.length);
  }

  return result;
}

export function inferResponseSpec(responseBodies: string[]): InferredField | null {
  const parsed: any[] = [];
  for (const body of responseBodies) {
    if (!body) continue;
    try {
      parsed.push(JSON.parse(body));
    } catch {
      continue;
    }
  }
  if (parsed.length === 0) return null;

  return inferFromValues(parsed, parsed.length);
}
