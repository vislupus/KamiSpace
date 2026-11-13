// History-API router for the three in-app routes.
const guards = new Set();
let handler = () => {};

export function parseRoute(pathname = location.pathname) {
  const page = pathname.match(/^\/p\/(\d+)\/?$/);
  if (page) return { name: 'page', pageId: Number(page[1]) };
  if (pathname === '/trash') return { name: 'trash' };
  return { name: 'home' };
}

export function pagePath(pageId) {
  return `/p/${pageId}`;
}

/** Register an async function that runs before leaving the current view. */
export function addLeaveGuard(guard) {
  guards.add(guard);
  return () => guards.delete(guard);
}

async function runGuards() {
  for (const guard of [...guards]) {
    try {
      await guard();
    } catch {
      // A failing guard must not trap the user on the page.
    }
  }
}

export async function navigate(path, { replace = false } = {}) {
  if (path === location.pathname) return;
  await runGuards();
  if (replace) history.replaceState(null, '', path);
  else history.pushState(null, '', path);
  handler(parseRoute());
}

export function startRouter(onRoute) {
  handler = onRoute;
  window.addEventListener('popstate', async () => {
    await runGuards();
    handler(parseRoute());
  });
  // In-app links: <a href="/p/1" data-link>
  document.addEventListener('click', (event) => {
    if (event.defaultPrevented || event.button !== 0) return;
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    const link = event.target.closest?.('a[data-link]');
    if (!link) return;
    event.preventDefault();
    navigate(link.getAttribute('href'));
  });
  handler(parseRoute());
}
