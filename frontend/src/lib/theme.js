// Light / dark / system theme, persisted in localStorage.
const KEY = 'kamispace.theme';
const media = window.matchMedia('(prefers-color-scheme: dark)');

export function getThemeChoice() {
  try {
    // The second key is the one used before the project was renamed.
    return localStorage.getItem(KEY) || localStorage.getItem('minddock.theme') || 'system';
  } catch {
    return 'system';
  }
}

function apply(choice) {
  const dark = choice === 'dark' || (choice === 'system' && media.matches);
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
  document.documentElement.dataset.themeChoice = choice;
}

export function setThemeChoice(choice) {
  try {
    localStorage.setItem(KEY, choice);
  } catch {
    // ignore
  }
  apply(choice);
}

media.addEventListener('change', () => {
  if (getThemeChoice() === 'system') apply('system');
});
