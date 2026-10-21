import * as React from "react";
import { cn } from "@/lib/utils";

export const Input = React.forwardRef<HTMLInputElement, React.InputHTMLAttributes<HTMLInputElement>>(
  ({ className, type, ...props }, ref) => (
    <input
      ref={ref}
      type={type}
      className={cn(
        "h-7 w-full border border-bg-line bg-bg px-2 font-mono text-[12px] text-ink placeholder:text-ink-faint focus-visible:border-neon-cyan/70 focus-visible:outline-none",
        className,
      )}
      {...props}
    />
  ),
);
Input.displayName = "Input";

export const Select = React.forwardRef<HTMLSelectElement, React.SelectHTMLAttributes<HTMLSelectElement>>(
  ({ className, ...props }, ref) => (
    <select
      ref={ref}
      className={cn(
        "h-7 border border-bg-line bg-bg px-1.5 font-mono text-[12px] text-ink focus-visible:border-neon-cyan/70 focus-visible:outline-none",
        className,
      )}
      {...props}
    />
  ),
);
Select.displayName = "Select";
