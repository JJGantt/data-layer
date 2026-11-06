// Which catalog offers get an `open:` link for the bedroom TV.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { tvLink } from '../dist/catalog.js';

const offer = (technicalName, deeplinkURL, standardWebURL) => ({ package: { technicalName }, deeplinkURL, standardWebURL });

describe('tvLink', () => {
  test('a service with a TV app gets its package added when the link lacks one', () => {
    assert.equal(tvLink(offer('appletvplus', 'intent://tv.apple.com/us/movie/x#Intent;scheme=https;end')),
      'intent://tv.apple.com/us/movie/x#Intent;scheme=https;package=com.apple.atve.androidtv.appletv;end');
    assert.equal(tvLink(offer('hulu', undefined, 'https://www.hulu.com/movie/x')), 'https://www.hulu.com/movie/x');
    assert.equal(tvLink(offer('itunes', 'intent://tv.apple.com/us/movie/x#Intent;scheme=https;end')),
      'intent://tv.apple.com/us/movie/x#Intent;scheme=https;package=com.apple.atve.androidtv.appletv;end');
  });

  test('a service with no app on the TV gets no link', () => {
    assert.equal(tvLink(offer('vudu', 'intent://play?contentId=1#Intent;scheme=vuduapp;component=air.com.vudu.air.DownloaderTablet/.TvMainActivity;end')), undefined);
    assert.equal(tvLink(offer('plex', 'intent://watch.plex.tv/movie/weapons-2025#Intent;launchFlags=0x00800000;scheme=https;end')), undefined);
    assert.equal(tvLink(offer('plex', undefined, 'https://watch.plex.tv/movie/x')), undefined);
    assert.equal(tvLink(offer('peacocktv', 'intent://x#Intent;package=com.peacocktv.peacockandroid;scheme=https;end')), undefined);
  });

  test('an unmapped service whose link names an installed app keeps it', () => {
    const rent = 'intent://watch.amazon.com/watch?asin=B0FG67CL7J#Intent;package=com.amazon.amazonvideo.livingroom;scheme=https;end';
    assert.equal(tvLink(offer('amazonhbomax', rent)), rent);
  });
});
