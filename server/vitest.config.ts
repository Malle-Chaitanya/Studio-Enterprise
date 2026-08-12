import { defineConfig } from 'vitest/config';

/**
 * Unit tests for the pure transforms.
 *
 * Scope is deliberately narrow. `.claude/rules/testing-standard.md` says to unit-test the
 * data-in/data-out functions first — mapper, topicCompiler, knowledgeClassifier, scope, and
 * the connector parsers — and to keep the `_test_*` / `_diag_*` spikes for the live
 * integration probes that mocks cannot cover. Nothing here touches Dataverse, Discovery
 * Engine, Secret Manager or Mongo; anything that needs a real credential stays a spike.
 *
 * `src/spikes` is excluded for the same reason it is excluded from tsconfig: those files
 * are throwaway probes, exempt from the rules the rest of the tree follows, and several are
 * named `_test_*` so they would otherwise be collected here by accident.
 */
export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    exclude: ['src/spikes/**', 'node_modules/**', 'dist/**'],
    environment: 'node',
  },
});
