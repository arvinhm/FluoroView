/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        ink: {
          950: "#05070d",
          900: "#080b14",
          850: "#0b0f1c",
          800: "#0f1626",
          700: "#151f36",
          600: "#1e2b47",
          500: "#2b3c60",
        },
        cyanx: "#22d3ee",
        violetx: "#8b5cf6",
        magentax: "#ec4899",
        limex: "#a3e635",
        amberx: "#fbbf24",
      },
      fontFamily: {
        sans: ["Inter", "SF Pro Display", "system-ui", "sans-serif"],
        mono: ["JetBrains Mono", "SF Mono", "ui-monospace", "monospace"],
      },
      boxShadow: {
        glow: "0 0 40px -8px rgba(34,211,238,0.45)",
        "glow-violet": "0 0 44px -10px rgba(139,92,246,0.55)",
        panel: "0 24px 60px -24px rgba(0,0,0,0.75)",
        inset: "inset 0 1px 0 0 rgba(255,255,255,0.06)",
      },
      backgroundImage: {
        "grid-fade":
          "radial-gradient(circle at 50% 0%, rgba(34,211,238,0.10), transparent 60%)",
        "aurora":
          "conic-gradient(from 180deg at 50% 50%, #22d3ee33, #8b5cf633, #ec489933, #22d3ee33)",
      },
      keyframes: {
        float: {
          "0%,100%": { transform: "translateY(0)" },
          "50%": { transform: "translateY(-12px)" },
        },
        shimmer: {
          "100%": { transform: "translateX(100%)" },
        },
        pulseglow: {
          "0%,100%": { opacity: "0.55" },
          "50%": { opacity: "1" },
        },
        spinslow: {
          to: { transform: "rotate(360deg)" },
        },
        gridpan: {
          to: { backgroundPosition: "40px 40px" },
        },
      },
      animation: {
        float: "float 6s ease-in-out infinite",
        shimmer: "shimmer 2.2s infinite",
        pulseglow: "pulseglow 3.4s ease-in-out infinite",
        spinslow: "spinslow 14s linear infinite",
        gridpan: "gridpan 6s linear infinite",
      },
    },
  },
  plugins: [],
};
