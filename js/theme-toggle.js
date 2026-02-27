(() => {
  // Persist the selected theme across page loads.
  const STORAGE_KEY = "interviewai-theme";

  function getStoredTheme() {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored === "light" || stored === "dark") return stored;
    return null;
  }

  function getSystemTheme() {
    return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  }

  function getActiveTheme() {
    return getStoredTheme() || getSystemTheme();
  }

  function applyTheme(theme) {
    // Apply theme to root element and keep toggle button label in sync.
    document.documentElement.setAttribute("data-theme", theme);
    localStorage.setItem(STORAGE_KEY, theme);

    const button = document.getElementById("theme-toggle-btn");
    if (!button) return;

    const isDark = theme === "dark";
    button.innerHTML = isDark
      ? '<i class="fa-regular fa-sun icon-left"></i>Light Mode'
      : '<i class="fa-regular fa-moon icon-left"></i>Dark Mode';
    button.setAttribute("aria-label", isDark ? "Switch to light mode" : "Switch to dark mode");
  }

  function toggleTheme() {
    // Flip between dark/light modes based on current active theme.
    const current = document.documentElement.getAttribute("data-theme") || getActiveTheme();
    applyTheme(current === "dark" ? "light" : "dark");
  }

  function ensureButton() {
    // Create toggle button dynamically so every page gets consistent control.
    if (document.getElementById("theme-toggle-btn")) return;

    const button = document.createElement("button");
    button.id = "theme-toggle-btn";
    button.type = "button";
    button.className = "theme-toggle-btn";
    button.addEventListener("click", toggleTheme);

    document.body.appendChild(button);
  }

  document.addEventListener("DOMContentLoaded", () => {
    ensureButton();
    applyTheme(getActiveTheme());
  });
})();
