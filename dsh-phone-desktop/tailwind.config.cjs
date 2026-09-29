/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ["./index.html", "./src/**/*.{js,ts,jsx,tsx}"],
  theme: {
    extend: {
      colors: {
        ink: "#0a0a0d",
        panel: "#0e0e12",
        rise: "#121217",
        edge: "#1d1d23",
        faint: "#3b3b42",
        bone: "#cfcec6",
        ash: "#6f6f75",
        blood: "#8a3838",
        ember: "#a84848",
        moss: "#5c7656",
      },
      fontFamily: {
        mono: ["JetBrains Mono", "ui-monospace", "SFMono-Regular", "Consolas", "monospace"],
        sans: ["Segoe UI", "system-ui", "-apple-system", "Roboto", "sans-serif"],
      },
    },
  },
  plugins: [],
};