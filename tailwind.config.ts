import type { Config } from "tailwindcss";
import animate from "tailwindcss-animate";

export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    container: { center: true, padding: "1.25rem", screens: { "2xl": "1200px" } },
    extend: {
      fontFamily: {
        sans: ["Inter", "system-ui", "sans-serif"],
        display: ["Fraunces", "Georgia", "serif"],
      },
      colors: {
        navy: {
          50: "#EEF1F8", 100: "#D9DFEE", 200: "#B3BEDC", 300: "#8495C2", 400: "#5868A0",
          500: "#3B4A82", 600: "#2A3868", 700: "#1E2A52", 800: "#152043", 900: "#0E1A3A", 950: "#08112A",
        },
        cream: { 50: "#FFFDF9", 100: "#FBF7F0", 200: "#F4EDE0", 300: "#E9DEC9" },
        gold: { 100: "#F7EDD5", 200: "#EFD9A6", 300: "#E3C176", 400: "#D4A84B", 500: "#B98C2E", 600: "#8F6A1F" },
      },
      borderRadius: { xl: "1rem", "2xl": "1.25rem", "3xl": "1.75rem" },
      boxShadow: {
        card: "0 1px 2px rgba(14,26,58,.06), 0 8px 24px -12px rgba(14,26,58,.18)",
        glow: "0 0 0 1px rgba(212,168,75,.35), 0 18px 40px -18px rgba(14,26,58,.55)",
      },
      keyframes: {
        "reveal-up": { "0%": { opacity: "0", transform: "translateY(16px) scale(.98)" }, "100%": { opacity: "1", transform: "none" } },
        "fade-in": { "0%": { opacity: "0" }, "100%": { opacity: "1" } },
        shimmer: { "0%": { backgroundPosition: "-200% 0" }, "100%": { backgroundPosition: "200% 0" } },
      },
      animation: {
        "reveal-up": "reveal-up .7s cubic-bezier(.2,.8,.2,1) both",
        "fade-in": "fade-in .4s ease-out both",
        shimmer: "shimmer 2.4s linear infinite",
      },
    },
  },
  plugins: [animate],
} satisfies Config;
