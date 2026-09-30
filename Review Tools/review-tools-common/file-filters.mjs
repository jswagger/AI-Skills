function compileGlob(pattern) {
  const expression = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\?/g, '[^/]')
    .replace(/\*\*\//g, '\u0000')
    .replace(/\*\*/g, '\u0001')
    .replace(/\*/g, '[^/]*')
    .replace(/\u0000/g, '(?:.*/)?')
    .replace(/\u0001/g, '.*');
  return new RegExp(`^${expression}$`);
}

function matches(patterns, filePath) {
  const normalizedPath = filePath.replaceAll('\\', '/');
  const basename = normalizedPath.slice(normalizedPath.lastIndexOf('/') + 1);
  return patterns.some((pattern) => pattern.test(normalizedPath) || pattern.test(basename));
}

export function createFileFilters(scanConfig = {}) {
  const excludePatterns = (scanConfig.exclude ?? []).map(compileGlob);
  const testPatterns = (scanConfig.testFiles?.patterns ?? []).map(compileGlob);

  return {
    isExcluded: (filePath) => matches(excludePatterns, filePath),
    isTestFile: (filePath) => matches(testPatterns, filePath),
  };
}