import * as React from "react";
import { Slot } from "@radix-ui/react-slot";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";

const buttonVariants = cva(
  "inline-flex items-center justify-center gap-1.5 whitespace-nowrap font-mono text-[11px] uppercase tracking-wider transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-neon-cyan disabled:pointer-events-none disabled:opacity-40",
  {
    variants: {
      variant: {
        default: "border border-bg-line bg-bg-raised text-ink hover:border-ink-faint hover:bg-[#1c2128]",
        primary: "border border-neon-green/60 bg-neon-green/10 text-neon-green hover:bg-neon-green/20",
        danger: "border border-neon-red/60 bg-neon-red/10 text-neon-red hover:bg-neon-red/20",
        ghost: "border border-transparent text-ink-dim hover:bg-bg-raised hover:text-ink",
        active: "border border-neon-cyan/70 bg-neon-cyan/10 text-neon-cyan",
      },
      size: {
        sm: "h-6 px-2",
        md: "h-7 px-3",
        icon: "h-7 w-7",
      },
    },
    defaultVariants: { variant: "default", size: "md" },
  },
);

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {
  asChild?: boolean;
}

export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, asChild = false, ...props }, ref) => {
    const Comp = asChild ? Slot : "button";
    return <Comp ref={ref} className={cn(buttonVariants({ variant, size }), className)} {...props} />;
  },
);
Button.displayName = "Button";
