module.exports = {
  content: ["./index.html", "./*.js", "./src/**/*.js"],
  safelist: {
    standard: [
      "active",
      "hidden",
      "show",
      "visible",
      "disabled",
      "selected"
    ],
    deep: [/^taskbar/, /^drawer-/, /^chat-/, /^login-/, /^renderer-/]
  }
};
