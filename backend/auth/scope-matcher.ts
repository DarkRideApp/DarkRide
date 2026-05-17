/**
 * Scope matching logic for DarkRide's area-level permission system.
 *
 * Scope format: `{namespace}.{area}[.{subarea}]:{verb}`
 * Example: `plugin.example.feature_a:read`
 *
 * Matching rules:
 *   1. Exact match
 *   2. Verb wildcard: `area:*` covers any verb on that exact area
 *   3. Subtree wildcard: `area.*:verb` covers the verb on any sub-area
 *   4. Prefix + verb wildcard: `area:*` where area is a prefix of required area
 *   5. Universal: `core.admin:*` covers everything
 */

/**
 * Does a single grant string cover a single required scope?
 */
export function scopeCovers(grant: string, required: string): boolean {
  if (grant === required) return true;

  const colonG = grant.indexOf(':');
  const colonR = required.indexOf(':');
  if (colonG === -1 || colonR === -1) return false;

  const grantArea = grant.substring(0, colonG);
  const grantVerb = grant.substring(colonG + 1);
  const requiredArea = required.substring(0, colonR);
  const requiredVerb = required.substring(colonR + 1);

  // Rule 5: universal
  if (grantArea === 'core.admin' && grantVerb === '*') return true;

  // Rule 2: verb wildcard on exact area
  if (grantArea === requiredArea && grantVerb === '*') return true;

  // Rule 3: subtree wildcard — `area.*:verb`
  if (grantArea.endsWith('.*')) {
    const prefix = grantArea.substring(0, grantArea.length - 2);
    if (requiredArea.startsWith(prefix + '.')) {
      return grantVerb === '*' || grantVerb === requiredVerb;
    }
  }

  // Rule 4: prefix + verb wildcard — `area:*` covers `area.sub.area:verb`
  if (grantVerb === '*' && requiredArea.startsWith(grantArea + '.')) {
    return true;
  }

  return false;
}

/**
 * Does a set of granted scopes cover a required scope?
 */
export function scopeMatches(grants: Set<string>, required: string): boolean {
  for (const grant of grants) {
    if (scopeCovers(grant, required)) return true;
  }
  return false;
}

/**
 * Returns the set of plugin-declared scopes that the user's grant covers.
 * Plugin scopes are assumed concrete (no wildcards) — enforced at plugin load.
 * The result preserves the plugin's original scope strings; a user with
 * `core.admin:*` acting through a plugin with `['core.apk:read']` gets
 * exactly `['core.apk:read']`, never widened.
 */
export function scopeIntersect(
  userScopes: Set<string>,
  pluginScopes: readonly string[],
): string[] {
  return pluginScopes.filter(s => scopeMatches(userScopes, s));
}
