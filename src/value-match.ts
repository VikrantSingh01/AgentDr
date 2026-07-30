export function isSubset(expected: unknown, actual: unknown): boolean {
  if (expected === null || typeof expected !== "object") {
    return Object.is(expected, actual);
  }
  if (actual === null || typeof actual !== "object") return false;

  if (Array.isArray(expected)) {
    return (
      Array.isArray(actual) &&
      expected.length === actual.length &&
      expected.every((value, index) => isSubset(value, actual[index]))
    );
  }

  return Object.entries(expected).every(([key, value]) =>
    isSubset(value, (actual as Record<string, unknown>)[key])
  );
}

export function isStructurallyEqual(left: unknown, right: unknown): boolean {
  return isSubset(left, right) && isSubset(right, left);
}
