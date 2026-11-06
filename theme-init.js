(() => {
  let savedTheme = null;
  try {
    savedTheme = window.localStorage.getItem("conflict-tracker-theme");
  } catch {
    // Local storage can be unavailable in privacy-restricted browsing modes.
  }

  const preferredTheme = window.matchMedia?.("(prefers-color-scheme: dark)").matches
    ? "dark"
    : "light";
  document.documentElement.dataset.theme =
    savedTheme === "dark" || savedTheme === "light" ? savedTheme : preferredTheme;
})();
