import path from 'path';
import YAML from 'yaml';

/**
 * Validates YAML syntax.
 * Returns true if valid, or a detailed error message if invalid.
 */
export function validateYaml(content: string): { isValid: boolean; error: string | null } {
  try {
    YAML.parse(content);
    return { isValid: true, error: null };
  } catch (err: any) {
    return { isValid: false, error: err.message || 'Unknown YAML parsing error' };
  }
}

/**
 * Validates that a path resides strictly within the allowed base directory.
 * Prevents directory traversal (e.g., ../../) outside the configuration sandbox.
 */
export function isPathSafe(baseDir: string, targetPath: string, isRemote = false): boolean {
  const p = isRemote ? path.posix : path;
  const resolvedBase = p.resolve(baseDir);
  const resolvedTarget = p.resolve(baseDir, targetPath);

  return resolvedTarget.startsWith(resolvedBase);
}

/**
 * Resolves the relative path within the instance sandbox to an absolute path.
 * Throws an error if the path is unsafe.
 */
export function resolveSafePath(baseDir: string, relativePath: string, isRemote = false): string {
  const p = isRemote ? path.posix : path;
  const normalizedRelative = relativePath.replace(/\\/g, '/');
  
  if (!isPathSafe(baseDir, normalizedRelative, isRemote)) {
    throw new Error(`Security Denied: Path "${relativePath}" resolves outside the configuration sandbox "${baseDir}"`);
  }

  return p.resolve(baseDir, normalizedRelative);
}
