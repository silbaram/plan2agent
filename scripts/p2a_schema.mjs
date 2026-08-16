/** Minimal JSON Schema validator shared by runtime modules. */

export class ValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ValidationError';
  }
}

function schemaTypeMatches(instance, expectedType) {
  if (expectedType === 'object') return instance !== null && typeof instance === 'object' && !Array.isArray(instance);
  if (expectedType === 'array') return Array.isArray(instance);
  if (expectedType === 'string') return typeof instance === 'string';
  if (expectedType === 'boolean') return typeof instance === 'boolean';
  if (expectedType === 'null') return instance === null;
  if (expectedType === 'number') return typeof instance === 'number' && Number.isFinite(instance);
  if (expectedType === 'integer') return Number.isInteger(instance);
  throw new ValidationError(`unsupported schema type ${JSON.stringify(expectedType)} at $`);
}

function resolveLocalSchemaReference(rootSchema, reference, instancePath) {
  if (typeof reference !== 'string' || !reference.startsWith('#/')) {
    throw new ValidationError(`${instancePath} uses unsupported schema reference ${JSON.stringify(reference)}`);
  }
  let resolved = rootSchema;
  for (const encodedSegment of reference.slice(2).split('/')) {
    const segment = encodedSegment.replaceAll('~1', '/').replaceAll('~0', '~');
    if (
      !resolved
      || typeof resolved !== 'object'
      || Array.isArray(resolved)
      || !Object.hasOwn(resolved, segment)
    ) {
      throw new ValidationError(`${instancePath} cannot resolve schema reference ${JSON.stringify(reference)}`);
    }
    resolved = resolved[segment];
  }
  return resolved;
}

function sameSchemaValue(left, right) {
  if (left === right) return true;
  if (Array.isArray(left) || Array.isArray(right)) {
    return (
      Array.isArray(left)
      && Array.isArray(right)
      && left.length === right.length
      && left.every((item, index) => sameSchemaValue(item, right[index]))
    );
  }
  if (
    left !== null
    && right !== null
    && typeof left === 'object'
    && typeof right === 'object'
  ) {
    const leftKeys = Object.keys(left).sort();
    const rightKeys = Object.keys(right).sort();
    return (
      leftKeys.length === rightKeys.length
      && leftKeys.every((key, index) => (
        key === rightKeys[index]
        && sameSchemaValue(left[key], right[key])
      ))
    );
  }
  return false;
}

function schemaMatches(instance, schema, rootSchema = schema) {
  try {
    validateSchema(instance, schema, '$', rootSchema);
    return true;
  } catch (error) {
    if (error instanceof ValidationError) return false;
    throw error;
  }
}

function validateSchemaComposition(instance, schema, schemaPath, instancePath, rootSchema) {
  if (schema.if) {
    const matched = schemaMatches(instance, schema.if, rootSchema);
    if (matched && schema.then) validateSchema(instance, schema.then, instancePath, rootSchema);
    if (!matched && schema.else) validateSchema(instance, schema.else, instancePath, rootSchema);
    return;
  }
  validateSchema(instance, schema, schemaPath, rootSchema);
}

export function validateSchema(instance, schema, instancePath = '$', rootSchema = schema) {
  if (schema.$ref) {
    validateSchema(
      instance,
      resolveLocalSchemaReference(rootSchema, schema.$ref, instancePath),
      instancePath,
      rootSchema,
    );
  }
  if (schema.allOf) {
    for (const [index, subschema] of schema.allOf.entries()) {
      validateSchemaComposition(
        instance,
        subschema,
        `${instancePath}.allOf[${index}]`,
        instancePath,
        rootSchema,
      );
    }
  }
  if (schema.oneOf) {
    const matchCount = schema.oneOf.filter(
      (subschema) => schemaMatches(instance, subschema, rootSchema),
    ).length;
    if (matchCount !== 1) {
      throw new ValidationError(`${instancePath} must match exactly one oneOf schema (matched ${matchCount})`);
    }
  }

  if (Object.hasOwn(schema, 'const') && instance !== schema.const) {
    throw new ValidationError(`${instancePath} must equal ${JSON.stringify(schema.const)}`);
  }

  if (Object.hasOwn(schema, 'enum') && !schema.enum.includes(instance)) {
    throw new ValidationError(`${instancePath} must be one of ${JSON.stringify(schema.enum)}`);
  }

  const expectedType = schema.type;
  if (expectedType) {
    const supported = new Set(['object', 'array', 'string', 'boolean', 'null', 'number', 'integer']);
    const expectedTypes = Array.isArray(expectedType) ? expectedType : [expectedType];
    const unsupported = expectedTypes.filter((type) => !supported.has(type));
    if (unsupported.length) {
      throw new ValidationError(`unsupported schema type ${JSON.stringify(expectedType)} at ${instancePath}`);
    }
    if (!expectedTypes.some((type) => schemaTypeMatches(instance, type))) {
      throw new ValidationError(`${instancePath} must be ${expectedTypes.join(' or ')}`);
    }
  }

  if (typeof instance === 'string') {
    if (Object.hasOwn(schema, 'minLength') && instance.length < schema.minLength) {
      throw new ValidationError(`${instancePath} must have length >= ${schema.minLength}`);
    }
    if (Object.hasOwn(schema, 'pattern') && !new RegExp(schema.pattern).test(instance)) {
      throw new ValidationError(`${instancePath} must match pattern ${JSON.stringify(schema.pattern)}`);
    }
  }

  if (typeof instance === 'number') {
    if (Object.hasOwn(schema, 'minimum') && instance < schema.minimum) {
      throw new ValidationError(`${instancePath} must be >= ${schema.minimum}`);
    }
    if (Object.hasOwn(schema, 'maximum') && instance > schema.maximum) {
      throw new ValidationError(`${instancePath} must be <= ${schema.maximum}`);
    }
  }

  if (Array.isArray(instance)) {
    if (Object.hasOwn(schema, 'minItems') && instance.length < schema.minItems) {
      throw new ValidationError(`${instancePath} must contain at least ${schema.minItems} item(s)`);
    }
    if (Object.hasOwn(schema, 'maxItems') && instance.length > schema.maxItems) {
      throw new ValidationError(`${instancePath} must contain at most ${schema.maxItems} item(s)`);
    }
    if (
      schema.uniqueItems === true
      && instance.some((item, index) => (
        instance.slice(0, index).some((previous) => sameSchemaValue(previous, item))
      ))
    ) {
      throw new ValidationError(`${instancePath} must contain unique items`);
    }
    if (schema.items) {
      instance.forEach((item, index) => validateSchema(
        item,
        schema.items,
        `${instancePath}[${index}]`,
        rootSchema,
      ));
    }
  }

  if (schema.not && schemaMatches(instance, schema.not, rootSchema)) {
    throw new ValidationError(`${instancePath} must not match forbidden schema`);
  }

  if (instance !== null && typeof instance === 'object' && !Array.isArray(instance)) {
    const required = schema.required ?? [];
    const missing = required.filter((key) => !Object.hasOwn(instance, key));
    if (missing.length) {
      throw new ValidationError(`${instancePath} missing required keys: ${missing.join(', ')}`);
    }

    const properties = schema.properties ?? {};
    if (schema.additionalProperties === false) {
      const extras = Object.keys(instance).filter((key) => !Object.hasOwn(properties, key));
      if (extras.length) {
        throw new ValidationError(`${instancePath} contains unsupported keys: ${extras.join(', ')}`);
      }
    }

    for (const [key, value] of Object.entries(instance)) {
      if (Object.hasOwn(properties, key)) {
        validateSchema(value, properties[key], `${instancePath}.${key}`, rootSchema);
      }
    }
  }
}
