import type { ReactElement } from 'react';
import { Alert, AlertDescription } from '@/components/ui/alert.js';
import { cn } from '@/lib/utils.js';

/**
 * The refusal / success pair that appears under nearly every action on this
 * client. Consolidated out of eight near-identical copies.
 *
 * `role="alert"` on a refusal (assertive, interrupts) and `role="status"` on
 * success (polite, does not) is preserved exactly as it was inline -- a
 * refusal is the thing a screen reader user needs told immediately, a
 * confirmation is not.
 */
export function RefusalBanner(props: { children: string }): ReactElement {
  return (
    <Alert
      role="alert"
      variant="destructive"
      className={cn('border-2 border-destructive bg-[#FFF5F5]')}
    >
      <AlertDescription className="text-destructive font-medium leading-relaxed">
        {props.children}
      </AlertDescription>
    </Alert>
  );
}

export function DoneBanner(props: { children: string }): ReactElement {
  return (
    <Alert
      role="status"
      className="border border-[#7FB07F] bg-[#F1F8F1]"
    >
      <AlertDescription className="text-[#1c6b1c] font-medium leading-relaxed">
        {props.children}
      </AlertDescription>
    </Alert>
  );
}
