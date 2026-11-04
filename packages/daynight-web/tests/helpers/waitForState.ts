import { waitFor } from '@testing-library/react';

export const waitForState: typeof waitFor = (assertion, options) =>
  waitFor(assertion, { interval: 5, ...options });
