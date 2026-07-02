import * as React from 'react';
import * as SliderPrimitive from '@radix-ui/react-slider';
import { cn } from '@/lib/cn';

const Slider = React.forwardRef<
  React.ElementRef<typeof SliderPrimitive.Root>,
  React.ComponentPropsWithoutRef<typeof SliderPrimitive.Root>
>(({ className, ...props }, ref) => {
  // Radix puts role="slider" (and reads aria-label/aria-valuetext) on the THUMB, not
  // on Root. So labelling/description aria spread onto Root is inert for AT. Peel those
  // off and forward them to every Thumb so single-thumb sliders get an accessible name
  // + the formatted aria-valuetext (WCAG 4.1.2). (jsx-a11y can't catch this — the
  // aria-label IS present in the JSX, just on the wrong element.)
  const {
    'aria-label': ariaLabel,
    'aria-labelledby': ariaLabelledby,
    'aria-describedby': ariaDescribedby,
    'aria-valuetext': ariaValuetext,
    'aria-invalid': ariaInvalid,
    ...rest
  } = props;
  const thumbs = rest.value ?? rest.defaultValue ?? [0];
  return (
    <SliderPrimitive.Root
      ref={ref}
      className={cn(
        'relative flex w-full touch-none select-none items-center',
        'data-[disabled]:cursor-not-allowed data-[disabled]:opacity-50',
        className,
      )}
      {...rest}
    >
      <SliderPrimitive.Track className="relative h-1.5 w-full grow overflow-hidden rounded-full bg-muted">
        <SliderPrimitive.Range className="absolute h-full bg-primary" />
      </SliderPrimitive.Track>
      {thumbs.map((_, i) => (
        <SliderPrimitive.Thumb
          key={i}
          aria-label={ariaLabel}
          aria-labelledby={ariaLabelledby}
          aria-describedby={ariaDescribedby}
          aria-valuetext={ariaValuetext}
          aria-invalid={ariaInvalid}
          className={cn(
            'block h-4 w-4 rounded-full border border-primary/60 bg-background shadow transition-colors',
            'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background',
            // Radix Thumb is a <span> and signals disabled via data-disabled (not the
            // :disabled pseudo), so `disabled:` variants were dead. Opacity dimming is
            // already handled by the Root's data-[disabled]:opacity-50 above.
            'data-[disabled]:pointer-events-none',
          )}
        />
      ))}
    </SliderPrimitive.Root>
  );
});
Slider.displayName = SliderPrimitive.Root.displayName;

export { Slider };
