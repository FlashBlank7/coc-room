import type { Config } from "tailwindcss";

export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        ink: "#e8e3d8",
        panel: "#171b20",
        brass: "#c7a35c",
        danger: "#b85c5c",
      },
      fontFamily: {
        sans: ["Inter", "Segoe UI", "Microsoft YaHei", "sans-serif"],
        serif: ["Georgia", "Noto Serif SC", "serif"],
      },
    },
  },
  plugins: [],
} satisfies Config;
