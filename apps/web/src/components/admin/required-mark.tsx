import type { ReactElement } from 'react';

/**
 * The red star on a field that must be filled. The star is decoration; the
 * words are for a screen reader, which would otherwise read "asterisk".
 */
export function RequiredMark(): ReactElement {
  return (
    <>
      <span aria-hidden="true" className="ml-0.5 text-destructive">*</span>
      <span className="sr-only"> (required)</span>
    </>
  );
}
