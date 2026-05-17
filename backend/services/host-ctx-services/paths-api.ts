import type { PathsApi } from '@darkrideapp/plugin-sdk';

/**
 * PathsApi — thin wrapper over the host's DATA_ROOT path resolution.
 *
 * In Task 12 production wiring, bind the dep as:
 *   absoluteLocalPath: absoluteLocalPath  // from backend/config/paths.ts
 */
export interface PathsDeps {
  absoluteLocalPath: (rel: string) => string;
}

export function createPathsApi(deps: PathsDeps): PathsApi {
  return {
    fileStorage(rel) {
      return deps.absoluteLocalPath(rel);
    },
  };
}
