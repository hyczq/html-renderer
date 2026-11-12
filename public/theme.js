/* 全站主题初始化与深色模式切换（在 <head> 中同步加载，避免深色模式闪白） */
(function () {
  var root = document.documentElement;

  function stored() {
    try {
      return localStorage.getItem("theme");
    } catch (e) {
      return null;
    }
  }

  function preferred() {
    return window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches
      ? "dark"
      : "light";
  }

  var saved = stored();
  var theme = saved === "light" || saved === "dark" ? saved : preferred();
  root.setAttribute("data-theme", theme);

  function sync() {
    var current = root.getAttribute("data-theme") === "dark" ? "dark" : "light";
    var icon = document.getElementById("ti");
    if (icon) icon.textContent = current === "dark" ? "☀️" : "🌙";
    var button = document.getElementById("tt");
    if (button) {
      button.setAttribute("aria-label", current === "dark" ? "切换浅色模式" : "切换深色模式");
      button.setAttribute("aria-pressed", current === "dark" ? "true" : "false");
    }
  }

  function apply(next) {
    root.setAttribute("data-theme", next);
    try {
      localStorage.setItem("theme", next);
    } catch (e) {}
    sync();
  }

  function bind() {
    sync();
    var button = document.getElementById("tt");
    if (!button || button.dataset.themeBound) return;
    button.dataset.themeBound = "1";
    button.addEventListener("click", function () {
      apply(root.getAttribute("data-theme") === "dark" ? "light" : "dark");
    });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", bind);
  } else {
    bind();
  }

  window.HRTheme = {
    apply: apply,
    current: function () {
      return root.getAttribute("data-theme") === "dark" ? "dark" : "light";
    },
  };
})();
