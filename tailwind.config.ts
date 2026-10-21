import type { Config } from "tailwindcss";

const config: Config = {
  darkMode: ["class"],
  content: ["./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        bg: {
          DEFAULT: "#0a0b0d",
          panel: "#101216",
          raised: "#161a20",
          line: "#232830",
        },
        ink: {
          DEFAULT: "#d7dde5",
          dim: "#8a94a3",
          faint: "#566070",
        },
        neon: {
          green: "#39ff88",
          cyan: "#2fd8ff",
          amber: "#ffb020",
          red: "#ff4d5e",
          blue: "#4d8dff",
        },
      },
      fontFamily: {
        mono: ["var(--font-mono)", "ui-monospace", "SFMono-Regular", "Menlo", "monospace"],
        sans: ["var(--font-sans)", "ui-sans-serif", "system-ui", "sans-serif"],
      },
      borderRadius: {
        none: "0",
        sm: "2px",
        DEFAULT: "2px",
        md: "3px",
        lg: "4px",
      },
    },
  },
  plugins: [],
};

export default config;
