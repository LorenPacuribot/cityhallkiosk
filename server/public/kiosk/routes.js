// Public kiosk URLs. Preview/origin settings survive every page transition.
const CONTEXT = ['kiosk', 'preview', 'layout', 'idle', 'sync'];
const positiveId = value => /^[1-9]\d*$/.test(value || '') && Number.isSafeInteger(Number(value)) ? Number(value) : null;

export function readRoute(href) {
  const url = new URL(href, 'http://kiosk.local');
  const legacy = url.searchParams.get('screen');
  if (legacy) return { name: legacy, p: url.searchParams.has('id') ? { id: positiveId(url.searchParams.get('id')) } : {} };
  const path = url.pathname.replace(/\/+$/, '').replace(/^\/kiosk(?:\/landscape)?(?=\/|$)/, '') || '/';
  const q = url.searchParams;
  if (path === '/' || path === '/welcome') return { name: 'welcome', p: {} };
  if (path === '/home') return { name: 'home', p: {} };
  if (path === '/offices') return { name: 'offices', p: { floor: q.get('floor') || 'all' } };
  if (path === '/search') return { name: 'search', p: { q: q.get('q') || '' } };
  if (path === '/results') return { name: 'results', p: { q: q.get('q') || '', filter: q.get('filter') || 'all' } };
  if (path === '/map') return { name: 'map', p: { floor: Number(q.get('floor')) || 1 } };
  const detail = /^\/(offices|services|offsite)\/(\d+)$/.exec(path);
  if (detail && positiveId(detail[2])) return { name: { offices: 'office', services: 'service', offsite: 'offsite' }[detail[1]], p: { id: positiveId(detail[2]) } };
  if (path === '/directions') {
    const target = positiveId(q.get('office')) ? { officeId: positiveId(q.get('office')) }
      : positiveId(q.get('room')) ? { roomId: positiveId(q.get('room')) }
      : q.get('door') ? { openingId: q.get('door') } : null;
    if (target) return { name: 'navigate', p: { target, serviceId: positiveId(q.get('service')) } };
  }
  return { name: 'notfound', p: {} };
}

export function routeURL(name, p = {}, href) {
  const url = new URL(href, 'http://kiosk.local');
  const query = new URLSearchParams();
  for (const key of CONTEXT) if (url.searchParams.has(key)) query.set(key, url.searchParams.get(key));
  if (/^\/kiosk\/landscape(?:\/|$)/.test(url.pathname)) query.set('layout', 'landscape');
  const paths = { home: '/home', welcome: '', offices: '/offices', office: `/offices/${p.id}`, service: `/services/${p.id}`, offsite: `/offsite/${p.id}`, search: '/search', results: '/results', noresults: '/results', map: '/map', navigate: '/directions', noroute: '/directions', arrived: '/directions', notfound: '/not-found' };
  url.pathname = '/kiosk' + (paths[name] ?? '/not-found');
  if (['search', 'results', 'noresults'].includes(name) && p.q) query.set('q', p.q);
  if (name === 'results' && p.filter && p.filter !== 'all') query.set('filter', p.filter);
  if (['offices', 'map'].includes(name) && p.floor && p.floor !== 'all') query.set('floor', p.floor);
  if (p.target) {
    if (p.target.officeId) query.set('office', p.target.officeId);
    else if (p.target.roomId) query.set('room', p.target.roomId);
    else if (p.target.openingId) query.set('door', p.target.openingId);
    if (p.serviceId) query.set('service', p.serviceId);
  }
  url.search = query.toString(); url.hash = '';
  return url.pathname + url.search;
}
