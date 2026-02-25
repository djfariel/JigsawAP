module.exports = {
  plugins: [
    require("@fullhuman/postcss-purgecss")({
      content: ["./index.html", "./*.js", "./src/**/*.js"],
      safelist: {
        standard: ["active", "hidden", "show", "visible", "disabled", "selected"],
        deep: [/^taskbar/, /^drawer-/, /^chat-/, /^login-/, /^renderer-/]
      }
    }),
    require("cssnano")({
      preset: "default"
    })
  ]
};
