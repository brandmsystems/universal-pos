import * as React from "react"
import { Switch as SwitchPrimitive } from "radix-ui"
import { cn } from "cn"

/**
 * An on/off switch: the same fact as a checkbox (checked / onCheckedChange),
 * drawn as a sliding thumb. Radix gives it role="switch", aria-checked, Space
 * and Enter. The track is 44px wide so a finger lands on it; the slide is a
 * 150ms transition, cut to an instant under reduced motion (styles/motion.css).
 */
function Switch({
  className,
  ...props
}: React.ComponentProps<typeof SwitchPrimitive.Root>) {
  return (
    <SwitchPrimitive.Root
      data-slot="switch"
      className={cn(
        "peer inline-flex h-6 w-11 shrink-0 cursor-pointer items-center rounded-full border-2 border-transparent transition-colors duration-150 outline-none",
        // The track is 24px tall; the hit area is 40px, so a finger need not land on it exactly.
        "relative after:absolute after:-inset-y-2 after:-inset-x-1 after:content-['']",
        "bg-input data-[state=checked]:bg-primary",
        "focus-visible:ring-[3px] focus-visible:ring-ring/50",
        "disabled:cursor-not-allowed disabled:opacity-50",
        className
      )}
      {...props}
    >
      <SwitchPrimitive.Thumb
        data-slot="switch-thumb"
        className={cn(
          "pointer-events-none block size-5 rounded-full bg-background shadow-sm ring-0 transition-transform duration-150",
          "data-[state=checked]:translate-x-5 data-[state=unchecked]:translate-x-0"
        )}
      />
    </SwitchPrimitive.Root>
  )
}

export { Switch }
