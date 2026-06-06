import "@testing-library/jest-dom/vitest";

// vitest-axe@0.1.0: `extend-expect` only augments the TS types; the matchers
// must be registered at runtime via expect.extend (the package's built
// `dist/extend-expect.js` ships empty, so it registers nothing on its own).
import * as axeMatchers from "vitest-axe/matchers";
import { expect } from "vitest";
import "vitest-axe/extend-expect";

expect.extend(axeMatchers);
