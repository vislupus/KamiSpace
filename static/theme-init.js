// Applies the saved theme before first paint (kept tiny and render-blocking
// on purpose; an inline script would need a weaker Content-Security-Policy).
(function () {
  var theme = 'system';
  try {
    theme = localStorage.getItem('minddock.theme') || 'system';
  } catch (_) {}
  var dark =
    theme === 'dark' ||
    (theme === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches);
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
  document.documentElement.dataset.themeChoice = theme;
})();
