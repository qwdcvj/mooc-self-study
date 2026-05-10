// ==UserScript==
// @name         MOOC Auto Next Video
// @namespace    https://github.com/qwdcvj/mooc-self-study
// @version      0.1.0
// @description  When a course video naturally ends, click the next lesson/video button if one is visible.
// @author       qwdcvj
// @match        *://*.icourse163.org/*
// @match        *://*.imooc.com/*
// @match        *://*.xuetangx.com/*
// @match        *://*.chaoxing.com/*
// @grant        none
// @run-at       document-idle
// ==/UserScript==

(function () {
  'use strict';

  const CONFIG = {
    clickDelayMs: 1200,
    scanIntervalMs: 1500,
    debug: false,
    nextTextPatterns: [
      /下一[节课讲个]?/,
      /下一课/,
      /下一章/,
      /下一个/,
      /继续学习/,
      /继续播放/,
      /next/i,
      /continue/i
    ]
  };

  const state = {
    watchedVideos: new WeakSet(),
    pendingClick: false,
    lastUrl: location.href
  };

  function log(...args) {
    if (CONFIG.debug) {
      console.log('[MOOC Auto Next]', ...args);
    }
  }

  function isVisible(element) {
    if (!element) return false;
    const style = window.getComputedStyle(element);
    if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') {
      return false;
    }
    const rect = element.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  }

  function isDisabled(element) {
    return Boolean(
      element.disabled ||
      element.getAttribute('aria-disabled') === 'true' ||
      element.classList.contains('disabled') ||
      element.classList.contains('u-disabled')
    );
  }

  function getElementLabel(element) {
    return [
      element.innerText,
      element.textContent,
      element.getAttribute('aria-label'),
      element.getAttribute('title'),
      element.getAttribute('data-title'),
      element.getAttribute('data-name')
    ].filter(Boolean).join(' ').replace(/\s+/g, ' ').trim();
  }

  function looksLikeNextControl(element) {
    if (!isVisible(element) || isDisabled(element)) return false;

    const label = getElementLabel(element);
    if (CONFIG.nextTextPatterns.some((pattern) => pattern.test(label))) {
      return true;
    }

    const classAndId = `${element.id || ''} ${element.className || ''}`;
    return /next|continue|j-next|u-next/i.test(classAndId);
  }

  function findNextControl() {
    const selectors = [
      'button',
      'a',
      '[role="button"]',
      '.next',
      '.j-next',
      '.u-next',
      '.continue',
      '.next-btn',
      '.nextButton'
    ];

    const candidates = Array.from(document.querySelectorAll(selectors.join(',')));
    return candidates.find(looksLikeNextControl) || null;
  }

  function clickNextControl() {
    if (state.pendingClick) return;
    state.pendingClick = true;

    window.setTimeout(() => {
      const nextControl = findNextControl();
      if (nextControl) {
        log('Clicking next control:', getElementLabel(nextControl));
        nextControl.click();
      } else {
        log('No next control found.');
      }
      state.pendingClick = false;
    }, CONFIG.clickDelayMs);
  }

  function bindVideo(video) {
    if (state.watchedVideos.has(video)) return;
    state.watchedVideos.add(video);

    video.addEventListener('ended', () => {
      log('Video ended.');
      clickNextControl();
    });
  }

  function scanVideos() {
    document.querySelectorAll('video').forEach(bindVideo);
  }

  const observer = new MutationObserver(scanVideos);
  observer.observe(document.documentElement, { childList: true, subtree: true });

  window.setInterval(() => {
    if (state.lastUrl !== location.href) {
      state.lastUrl = location.href;
      state.pendingClick = false;
      log('Route changed:', state.lastUrl);
    }
    scanVideos();
  }, CONFIG.scanIntervalMs);

  scanVideos();
})();
