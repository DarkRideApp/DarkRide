import type { PluginDefinition, PluginInput } from './types/plugin';

const NAME_REGEX = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/;

export function definePlugin(input: PluginInput): PluginDefinition {
  if (!NAME_REGEX.test(input.name)) {
    throw new Error(
      `Plugin name must be lowercase alphanumeric with hyphens, got: "${input.name}"`,
    );
  }
  if (input.aiScopes !== undefined && !Array.isArray(input.aiScopes)) {
    throw new Error(
      `definePlugin: aiScopes must be an array of scope strings (plugin "${input.name}")`,
    );
  }
  return {
    name: input.name,
    version: input.version,
    darkride: input.darkride,
    dependencies: input.dependencies ?? [],
    optionalDependencies: input.optionalDependencies ?? [],
    aiScopes: input.aiScopes ?? [],
    startTimeoutMs: input.startTimeoutMs,
    register: input.register,
    start: input.start,
    stop: input.stop,
  };
}
