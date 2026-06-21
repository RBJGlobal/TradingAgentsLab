import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

// Unit tests for the Electron main-process modules (engine lifecycle, etc.)
// AND renderer component tests. Kept in tests/unit/ — outside the
// `electron/**` and `src/**` tsconfig includes — so the production build
// (`tsc -b && vite build`) never pulls in vitest types or the test files.
// Run with `npm run test:unit`.
//
// Default environment is `node` (the main-process tests need no DOM). React
// component tests opt into a DOM by adding `// @vitest-environment happy-dom`
// at the top of the file, so we don't pay DOM setup cost on the node tests.
// The react plugin is needed to transform JSX/TSX in the .tsx test files.
export default defineConfig({
  plugins: [react()],
  test: {
    include: ['tests/unit/**/*.test.{ts,tsx}'],
    environment: 'node',
  },
});
