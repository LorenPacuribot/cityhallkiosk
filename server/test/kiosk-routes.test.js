import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readRoute, routeURL } from '../public/kiosk/routes.js';

test('public URLs round trip without losing kiosk origin or preview context', () => {
  const source = 'https://hall.local/kiosk/landscape?kiosk=ENTRANCE&preview=1&idle=0&screen=home';
  for (const [name, p] of [
    ['home', {}], ['offices', {floor:'2'}], ['office', {id:12}], ['service', {id:243}],
    ['offsite', {id:20}], ['search', {q:'birth & marriage'}], ['results', {q:'tax',filter:'services'}],
    ['map', {floor:2}], ['navigate', {target:{officeId:12},serviceId:243}],
  ]) {
    const url = routeURL(name,p,source), parsed = readRoute(url);
    assert.equal(parsed.name,name);
    for (const [key,value] of Object.entries(p)) assert.deepEqual(parsed.p[key],value);
    assert.equal(new URL(url,source).searchParams.get('kiosk'),'ENTRANCE');
    assert.equal(new URL(url,source).searchParams.get('layout'),'landscape');
    assert.equal(new URL(url,source).searchParams.has('screen'),false);
  }
});
test('legacy links resolve and malformed public URLs fail safely', () => {
  assert.deepEqual(readRoute('/kiosk/?screen=service&id=243'),{name:'service',p:{id:243}});
  assert.equal(readRoute('/kiosk/?screen=welcome').name,'welcome'); // the cover; "Touch to start" opens home
  for (const url of ['/kiosk/offices/-1','/kiosk/services/0','/kiosk/services/9007199254740993','/kiosk/directions','/kiosks','/kiosk/unknown']) assert.equal(readRoute(url).name,'notfound',url);
});
