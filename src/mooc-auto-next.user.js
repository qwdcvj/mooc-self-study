// ==UserScript==
// @name         MOOC Study Assistant
// @namespace    https://github.com/qwdcvj/mooc-self-study
// @version      0.3.5
// @description  Save real learning progress, confirm reader page turns, and stay inside courseware menus.
// @author       qwdcvj
// @homepageURL  https://github.com/qwdcvj/mooc-self-study
// @downloadURL  https://raw.githubusercontent.com/qwdcvj/mooc-self-study/codex/study-assistant/src/mooc-auto-next.user.js
// @updateURL    https://raw.githubusercontent.com/qwdcvj/mooc-self-study/codex/study-assistant/src/mooc-auto-next.user.js
// @match        *://icourse163.org/*
// @match        *://*.icourse163.org/*
// @match        *://imooc.com/*
// @match        *://*.imooc.com/*
// @match        *://xuetangx.com/*
// @match        *://*.xuetangx.com/*
// @match        *://chaoxing.com/*
// @match        *://*.chaoxing.com/*
// @grant        none
// @run-at       document-idle
// ==/UserScript==

(function () {
  'use strict';

  const CONFIG = {
    clickDelayMs: 1200,
    scanIntervalMs: 3000,
    readingIntervalMs: 1000,
    mutationDebounceMs: 800,
    scrollDebounceMs: 500,
    saveVideoEveryMs: 5000,
    restoreSafeGapSeconds: 15,
    readingCompletePercent: 95,
    readingDwellSeconds: 30,
    documentPageDwellSeconds: 5,
    coursewareMenuOpenDelayMs: 500,
    coursewareNavMaxTopRatio: 0.48,
    documentPagerMinTopRatio: 0.45,
    readerScrollDelayMs: 650,
    pageTurnConfirmDelayMs: 1300,
    pageTurnMaxRetries: 3,
    pageIndicatorMaxFindAttempts: 4,
    maxSpeechChars: 12000,
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
    ],
    nextPageTextPatterns: [
      /下一页/,
      /下页/,
      /后一页/,
      /下一张/,
      /下一屏/,
      /next page/i
    ],
    blockedControlPatterns: [
      /完成|已学完|提交|交卷|签到|打卡|考试|测验|作业|答题|评价课程|课程评价|评分|认证|成绩|证书/,
      /finish|complete|submit|exam|quiz|test|homework|assignment|certificate|certification|score|grade|credential/i
    ],
    nonDocumentNextPatterns: [
      /下一[章节课讲个]/,
      /继续学习/,
      /继续播放/,
      /next lesson|next chapter|continue/i
    ],
    nonCourseControlPatterns: [
      /^课件$/,
      /讨论|讨论区|问答|答疑|评论|论坛|公告|通知|消息|分享|评价课程|课程评价|评分|认证|成绩|证书|老师提问|提问|客服|帮助/,
      /discuss|forum|comment|notice|message|share|rating|review|question|support|help|certificate|certification|score|grade|credential/i
    ],
    coursewareContentPatterns: [
      /^\s*\d+(?:\.\d+)+(?:\s|[：:、.．(（]).{1,100}/,
      /^\s*第[一二三四五六七八九十百千万\d]+[章节课讲]\s*.{1,100}/
    ],
    coursewareMenuPatterns: [
      /select|dropdown|menu|chapter|lesson|section|course|unit|j-|u-/i
    ],
    titleSelectors: [
      'h1',
      '.course-title',
      '.lesson-title',
      '.unit-title',
      '.video-title',
      '[class*="title"]'
    ],
    articleSelectors: [
      'article',
      'main',
      '.article',
      '.content',
      '.lesson-content',
      '.course-content',
      '.m-article',
      '.rich-text',
      '[class*="markdown"]'
    ]
  };

  const STORAGE_PREFIX = 'moocStudyAssistant:';

  const state = {
    watchedVideos: new WeakSet(),
    completedVideos: new WeakSet(),
    completedContentKeys: new Set(),
    videoSaveTimers: new WeakMap(),
    pendingClick: false,
    lastUrl: location.href,
    currentVideo: null,
    readingStartedAt: Date.now(),
    readingCompleted: false,
    readingPageSignature: '',
    documentReadyForCoursewareNext: false,
    scheduledScanId: 0,
    scheduledReadingId: 0,
    panel: null,
    launcher: null,
    notesInput: null,
    statusNode: null,
    progressNode: null,
    speechButton: null,
    speaking: false
  };

  const settings = loadJson('settings', {
    autoNextAfterComplete: true,
    autoNextAfterVideo: true,
    restoreVideoProgress: true,
    showPanel: true
  });

  if (typeof settings.autoNextAfterComplete === 'undefined') {
    settings.autoNextAfterComplete = true;
  }
  if (typeof settings.autoNextAfterVideo === 'undefined') {
    settings.autoNextAfterVideo = true;
  }

  function log(...args) {
    if (CONFIG.debug) {
      console.log('[MOOC Study Assistant]', ...args);
    }
  }

  function storageKey(suffix) {
    return `${STORAGE_PREFIX}${suffix}:${location.origin}${location.pathname}`;
  }

  function loadJson(suffix, fallback) {
    try {
      const raw = localStorage.getItem(storageKey(suffix));
      return raw ? JSON.parse(raw) : fallback;
    } catch (error) {
      log('Failed to load storage item:', suffix, error);
      return fallback;
    }
  }

  function saveJson(suffix, value) {
    try {
      localStorage.setItem(storageKey(suffix), JSON.stringify(value));
    } catch (error) {
      log('Failed to save storage item:', suffix, error);
    }
  }

  function saveSettings() {
    saveJson('settings', settings);
  }

  function getPageTitle() {
    for (const selector of CONFIG.titleSelectors) {
      const element = document.querySelector(selector);
      const text = cleanText(element && element.textContent);
      if (text && text.length >= 2 && text.length <= 120) {
        return text;
      }
    }
    return cleanText(document.title) || location.pathname;
  }

  function cleanText(text) {
    return String(text || '').replace(/\s+/g, ' ').trim();
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

  function isNonCourseControl(element) {
    if (!element) return true;
    const label = getElementLabel(element);
    const classAndId = getClassAndId(element);
    return CONFIG.nonCourseControlPatterns.some((pattern) => pattern.test(label) || pattern.test(classAndId));
  }

  function looksLikeNextControl(element) {
    if (!isVisible(element) || isDisabled(element)) return false;

    const label = getElementLabel(element);
    if (isNonCourseControl(element) || CONFIG.blockedControlPatterns.some((pattern) => pattern.test(label))) {
      return false;
    }

    if (CONFIG.nextTextPatterns.some((pattern) => pattern.test(label))) {
      return true;
    }

    const classAndId = `${element.id || ''} ${element.className || ''}`;
    return /next|continue|j-next|u-next/i.test(classAndId) &&
      !CONFIG.blockedControlPatterns.some((pattern) => pattern.test(classAndId));
  }

  function looksLikeNextDocumentPageControl(element) {
    if (!isVisible(element) || isDisabled(element)) return false;

    const label = getElementLabel(element);
    if (isNonCourseControl(element) || CONFIG.blockedControlPatterns.some((pattern) => pattern.test(label))) {
      return false;
    }
    if (CONFIG.nonDocumentNextPatterns.some((pattern) => pattern.test(label)) &&
        !CONFIG.nextPageTextPatterns.some((pattern) => pattern.test(label))) {
      return false;
    }

    if (CONFIG.nextPageTextPatterns.some((pattern) => pattern.test(label))) {
      return true;
    }

    const classAndId = getClassAndId(element);
    const parentText = getClassAndId(element.parentElement || document.body);
    return /(next[-_\s]?page|page[-_\s]?next|pager.*next|pagination.*next|pdf.*next|reader.*next)/i.test(`${classAndId} ${parentText}`);
  }

  function getClickableElement(element) {
    if (!element) return null;
    if (element.matches('button,a,[role="button"],[role="tab"]')) {
      return element;
    }
    return element.querySelector('button,a,[role="button"],[role="tab"],[onclick]') || element;
  }

  function getClickableAncestor(element, maxDepth = 6) {
    let current = element;
    for (let depth = 0; current && depth < maxDepth; depth += 1, current = current.parentElement) {
      if (current.matches('button,a,[role="button"],[role="tab"],[role="option"],[role="menuitem"],[onclick]')) {
        return current;
      }
    }
    return getClickableElement(element);
  }

  function looksLikeLessonControl(element) {
    const label = getElementLabel(element);
    return isVisible(element) &&
      !isDisabled(element) &&
      !isNonCourseControl(element) &&
      label.length >= 2 &&
      label.length <= 120 &&
      !CONFIG.blockedControlPatterns.some((pattern) => pattern.test(label));
  }

  function getClassAndId(element) {
    return `${element.id || ''} ${element.className || ''}`;
  }

  function getClassAndIdChain(element, maxDepth = 3) {
    const parts = [];
    let current = element;
    for (let depth = 0; current && depth < maxDepth; depth += 1, current = current.parentElement) {
      parts.push(getClassAndId(current));
    }
    return parts.join(' ');
  }

  function looksLikeCoursewareContentLabel(label) {
    const text = cleanText(label);
    if (!text || text.length < 2 || text.length > 140) return false;
    if (CONFIG.blockedControlPatterns.some((pattern) => pattern.test(text))) return false;
    if (CONFIG.nonCourseControlPatterns.some((pattern) => pattern.test(text))) return false;
    return CONFIG.coursewareContentPatterns.some((pattern) => pattern.test(text));
  }

  function hasDottedContentNumber(label) {
    return /^\s*\d+\.\d+/.test(cleanText(label));
  }

  function isChapterLabel(label) {
    return /^第[一二两三四五六七八九十百千万\d]+章/.test(cleanText(label));
  }

  function isMenuToggleElement(element) {
    if (!element) return false;
    const classAndId = getClassAndIdChain(element, 4);
    return element.getAttribute('aria-haspopup') === 'true' ||
      element.hasAttribute('aria-expanded') ||
      CONFIG.coursewareMenuPatterns.some((pattern) => pattern.test(classAndId));
  }

  function isNearElementColumn(element, referenceElement) {
    if (!element || !referenceElement) return true;
    const rect = element.getBoundingClientRect();
    const referenceRect = referenceElement.getBoundingClientRect();
    const centerX = rect.left + rect.width / 2;
    const referenceCenterX = referenceRect.left + referenceRect.width / 2;
    const tolerance = Math.max(referenceRect.width * 0.75, 120);
    return Math.abs(centerX - referenceCenterX) <= tolerance;
  }

  function sortByScreenPosition(elements) {
    return elements.slice().sort((left, right) => {
      const leftRect = left.getBoundingClientRect();
      const rightRect = right.getBoundingClientRect();
      return leftRect.top - rightRect.top || leftRect.left - rightRect.left;
    });
  }

  function parseChineseNumber(value) {
    const text = cleanText(value);
    if (/^\d+$/.test(text)) return Number(text);

    const digits = {
      零: 0,
      一: 1,
      二: 2,
      两: 2,
      三: 3,
      四: 4,
      五: 5,
      六: 6,
      七: 7,
      八: 8,
      九: 9
    };

    if (text === '十') return 10;
    if (text.includes('十')) {
      const [left, right] = text.split('十');
      const tens = left ? digits[left] || 0 : 1;
      const ones = right ? digits[right] || 0 : 0;
      return tens * 10 + ones;
    }

    return Array.from(text).reduce((total, char) => (total * 10) + (digits[char] || 0), 0) || null;
  }

  function getContentOrder(label) {
    const text = cleanText(label);
    const numberMatch = text.match(/^\s*(\d+(?:\.\d+)+)/);
    if (numberMatch) {
      const order = numberMatch[1].split('.').map(Number);
      const pageMatch = text.match(/[（(]\s*(\d+)\s*[）)]/);
      order.push(pageMatch ? Number(pageMatch[1]) : 0);
      return order;
    }

    const chapterMatch = text.match(/^\s*第([一二两三四五六七八九十百千万\d]+)[章节课讲]/);
    if (chapterMatch) {
      return [parseChineseNumber(chapterMatch[1]) || 0, 0];
    }

    return null;
  }

  function compareContentOrder(left, right) {
    if (!left || !right) return 0;
    const length = Math.max(left.length, right.length);
    for (let index = 0; index < length; index += 1) {
      const diff = (left[index] || 0) - (right[index] || 0);
      if (diff !== 0) return diff;
    }
    return 0;
  }

  function isCompactCoursewareCandidate(element) {
    const rect = element.getBoundingClientRect();
    return rect.width > 0 &&
      rect.height > 0 &&
      rect.height <= 96 &&
      rect.width <= Math.max(window.innerWidth || 0, 1280);
  }

  function isInCoursewareNavigationArea(element) {
    const rect = element.getBoundingClientRect();
    const viewportHeight = window.innerHeight || document.documentElement.clientHeight || 800;
    if (rect.top > viewportHeight * CONFIG.coursewareNavMaxTopRatio) return false;

    const classAndId = getClassAndIdChain(element, 5);
    if (CONFIG.nonCourseControlPatterns.some((pattern) => pattern.test(classAndId))) return false;

    let current = element;
    for (let depth = 0; current && depth < 6; depth += 1, current = current.parentElement) {
      const label = getElementLabel(current);
      if (/课件|learn|content|course|chapter|lesson|section|unit/i.test(`${label} ${getClassAndId(current)}`)) {
        return true;
      }
    }

    return hasDottedContentNumber(getElementLabel(element));
  }

  function looksLikeCoursewareContentControl(element) {
    if (!isVisible(element) || isDisabled(element) || !isCompactCoursewareCandidate(element)) return false;
    if (!isInCoursewareNavigationArea(element)) return false;

    const label = getElementLabel(element);
    if (!looksLikeCoursewareContentLabel(label)) return false;
    if (CONFIG.blockedControlPatterns.some((pattern) => pattern.test(getClassAndId(element)))) return false;
    return !isNonCourseControl(element);
  }

  function getCoursewareContentCandidates(container) {
    const selectors = [
      'button',
      'a',
      '[role="button"]',
      '[role="tab"]',
      '[role="option"]',
      '[role="menuitem"]',
      '[onclick]',
      'li',
      'span',
      '[class*="item"]',
      '[class*="option"]',
      '[class*="lesson"]',
      '[class*="chapter"]',
      '[class*="section"]',
      '[class*="unit"]'
    ];

    const seen = new Set();
    return Array.from(container.querySelectorAll(selectors.join(',')))
      .map((element, index) => ({
        element: getClickableElement(element),
        index
      }))
      .filter((item) => {
        if (!item.element || seen.has(item.element)) return false;
        seen.add(item.element);
        return looksLikeCoursewareContentControl(item.element);
      })
      .map((item) => ({
        element: item.element,
        index: item.index,
        label: cleanText(getElementLabel(item.element)),
        order: getContentOrder(getElementLabel(item.element))
      }))
      .filter((item) => item.order);
  }

  function getCurrentCoursewareLabel() {
    const candidates = getCoursewareContentCandidates(document.body);
    const activeDotted = candidates.find((item) => hasDottedContentNumber(item.label) && isActiveLessonControl(item.element));
    if (activeDotted) return activeDotted.label;

    const activeAny = candidates.find((item) => isActiveLessonControl(item.element));
    if (activeAny) return activeAny.label;

    const firstDotted = candidates.find((item) => hasDottedContentNumber(item.label));
    if (firstDotted) return firstDotted.label;

    const title = getPageTitle();
    return looksLikeCoursewareContentLabel(title) ? title : '';
  }

  function findNextVisibleCoursewareContentControl(referenceLabel) {
    const referenceOrder = getContentOrder(referenceLabel || getCurrentCoursewareLabel());
    const allCandidates = getCoursewareContentCandidates(document.body);
    if (allCandidates.length < 2) return null;

    const candidates = referenceOrder && referenceOrder.length >= 3
      ? allCandidates.filter((item) => hasDottedContentNumber(item.label) && item.order[0] === referenceOrder[0])
      : allCandidates;
    if (candidates.length < 2) return null;

    const activeDottedIndex = candidates.findIndex((item) => hasDottedContentNumber(item.label) && isActiveLessonControl(item.element));
    const activeIndex = activeDottedIndex >= 0
      ? activeDottedIndex
      : candidates.findIndex((item) => isActiveLessonControl(item.element));

    if (activeIndex >= 0) {
      const active = candidates[activeIndex];
      const next = candidates.slice(activeIndex + 1)
        .find((item) => !sameControl(item.element, active.element) &&
          !isActiveLessonControl(item.element) &&
          compareContentOrder(item.order, active.order) > 0);
      if (next) return next.element;
    }

    if (!referenceOrder) return null;

    const sameIndex = candidates.findIndex((item) => compareContentOrder(item.order, referenceOrder) === 0);
    if (sameIndex >= 0) {
      const next = candidates.slice(sameIndex + 1)
        .find((item) => compareContentOrder(item.order, referenceOrder) > 0);
      if (next) return next.element;
    }

    const nextByOrder = candidates.find((item) => compareContentOrder(item.order, referenceOrder) > 0);
    return nextByOrder ? nextByOrder.element : null;
  }

  function findCoursewareMenuToggle() {
    const referenceLabel = getCurrentCoursewareLabel();
    const referenceOrder = getContentOrder(referenceLabel);
    const selectors = [
      'button',
      'a',
      '[role="button"]',
      '[aria-haspopup]',
      '[aria-expanded]',
      '[class*="select"]',
      '[class*="dropdown"]',
      '[class*="chapter"]',
      '[class*="lesson"]',
      '[class*="section"]',
      '[class*="unit"]'
    ];

    const seen = new Set();
    const candidates = Array.from(document.querySelectorAll(selectors.join(',')))
      .map(getClickableElement)
      .filter((element) => {
        if (!element || seen.has(element)) return false;
        seen.add(element);
        if (!looksLikeCoursewareContentControl(element)) return false;
        if (!hasDottedContentNumber(getElementLabel(element))) return false;

        const classAndId = getClassAndIdChain(element, 4);
        const menuish = element.getAttribute('aria-haspopup') === 'true' ||
          element.hasAttribute('aria-expanded') ||
          CONFIG.coursewareMenuPatterns.some((pattern) => pattern.test(classAndId));
        if (!menuish) return false;

        if (!referenceOrder) return true;
        const order = getContentOrder(getElementLabel(element));
        return !order || compareContentOrder(order, referenceOrder) === 0;
      });

    const orderedCandidates = sortByScreenPosition(candidates);
    return orderedCandidates[0] || null;
  }

  function getCurrentChapterLabel() {
    const candidates = getCoursewareContentCandidates(document.body).filter((item) => isChapterLabel(item.label));
    const toggle = candidates.find((item) => isMenuToggleElement(item.element));
    if (toggle) return toggle.label;

    const active = candidates.find((item) => isActiveLessonControl(item.element));
    return active ? active.label : (candidates[0] ? candidates[0].label : '');
  }

  function findChapterMenuToggle() {
    const referenceLabel = getCurrentChapterLabel();
    const referenceOrder = getContentOrder(referenceLabel);
    const selectors = [
      'button',
      'a',
      '[role="button"]',
      '[aria-haspopup]',
      '[aria-expanded]',
      '[class*="select"]',
      '[class*="dropdown"]',
      '[class*="chapter"]',
      '[class*="lesson"]',
      '[class*="section"]',
      '[class*="unit"]'
    ];

    const seen = new Set();
    const candidates = Array.from(document.querySelectorAll(selectors.join(',')))
      .map(getClickableElement)
      .filter((element) => {
        if (!element || seen.has(element)) return false;
        seen.add(element);
        if (!looksLikeCoursewareContentControl(element)) return false;

        const label = getElementLabel(element);
        if (!isChapterLabel(label)) return false;

        if (!isMenuToggleElement(element)) return false;

        if (!referenceOrder) return true;
        const order = getContentOrder(label);
        return !order || compareContentOrder(order, referenceOrder) === 0;
      });

    const orderedCandidates = sortByScreenPosition(candidates);
    return orderedCandidates[0] || null;
  }

  function openCoursewareMenuForCurrentContent() {
    const toggle = findCoursewareMenuToggle();
    if (!toggle) return false;

    setStatus(`正在点击右侧小节菜单按钮：${getElementLabel(toggle) || '当前小节'}`);
    clickElementLikeMouse(toggle, { xRatio: 0.92 });
    return true;
  }

  function openChapterMenu() {
    const toggle = findChapterMenuToggle();
    if (!toggle) return false;

    setStatus(`正在点击左侧章节菜单按钮：${getElementLabel(toggle) || '当前章节'}`);
    clickElementLikeMouse(toggle, { xRatio: 0.92 });
    return true;
  }

  function findNextCoursewareContentControl() {
    return findNextVisibleCoursewareContentControl(getCurrentCoursewareLabel());
  }

  function hasExpandedCurrentSubsectionMenu() {
    const referenceOrder = getContentOrder(getCurrentCoursewareLabel());
    if (!referenceOrder || referenceOrder.length < 2) return false;

    const toggle = findCoursewareMenuToggle();
    const uniqueOrders = new Set(
      getCoursewareContentCandidates(document.body)
        .filter((item) => hasDottedContentNumber(item.label))
        .filter((item) => item.order[0] === referenceOrder[0])
        .filter((item) => !toggle || sameControl(item.element, toggle) || isNearElementColumn(item.element, toggle))
        .map((item) => item.order.slice(0, 2).join('.'))
    );

    return uniqueOrders.size > 1;
  }

  function findNextChapterControl() {
    const referenceOrder = getContentOrder(getCurrentChapterLabel());
    const toggle = findChapterMenuToggle();
    const candidates = getCoursewareContentCandidates(document.body)
      .filter((item) => isChapterLabel(item.label))
      .filter((item) => !toggle || sameControl(item.element, toggle) || isNearElementColumn(item.element, toggle));
    if (candidates.length < 2) return null;

    const activeIndex = candidates.findIndex((item) => isActiveLessonControl(item.element));
    if (activeIndex >= 0) {
      const active = candidates[activeIndex];
      const next = candidates.slice(activeIndex + 1)
        .find((item) => compareContentOrder(item.order, active.order) > 0);
      if (next) return next.element;
    }

    if (!referenceOrder) return null;
    const nextByOrder = candidates.find((item) => compareContentOrder(item.order, referenceOrder) > 0);
    return nextByOrder ? nextByOrder.element : null;
  }

  function isCoursewareLearningPage() {
    const decodedUrl = decodeURIComponent(location.href);
    if (/讨论|讨论区|问答|答疑|评论|论坛|公告|通知|消息|分享|评价课程|课程评价|评分|认证|成绩|证书|老师提问|提问|客服|帮助/.test(decodedUrl)) {
      return false;
    }
    if (/discuss|forum|comment|notice|message|share|rating|review|question|support|help|exam|quiz|test|homework|assignment|certificate|certification|score|grade|credential/i.test(decodedUrl)) {
      return false;
    }

    if (/icourse163\.org$/i.test(location.hostname) || /\.icourse163\.org$/i.test(location.hostname)) {
      const route = `${location.pathname}${location.hash}`;
      return /\/learn\/content/i.test(route) &&
        !/[?&#]type=(discuss|forum|qa|comment|exam|quiz|test|homework|assignment|certificate|certification|score|grade|credential)/i.test(decodedUrl);
    }

    return true;
  }

  function parseRgb(color) {
    const match = String(color || '').match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/i);
    return match ? match.slice(1, 4).map(Number) : null;
  }

  function isGreenish(color) {
    const rgb = parseRgb(color);
    if (!rgb) return false;
    const [red, green, blue] = rgb;
    return green >= 120 && green > red * 1.25 && green > blue * 1.1;
  }

  function isActiveLessonControl(element) {
    if (!element || !isVisible(element)) return false;
    if (element.getAttribute('aria-selected') === 'true' || element.getAttribute('aria-current') === 'true') {
      return true;
    }

    const classAndId = getClassAndId(element);
    if (/(^|[-_\s])(active|current|selected|checked|crt|cur|on|z-crt|z-sel|u-cur)([-_\s]|$)/i.test(classAndId)) {
      return true;
    }

    const style = window.getComputedStyle(element);
    return isGreenish(style.color) || isGreenish(style.borderColor) || isGreenish(style.backgroundColor);
  }

  function getLessonCandidates(container) {
    const selectors = [
      'button',
      'a',
      '[role="button"]',
      '[role="tab"]',
      '[onclick]',
      '[class*="tab"]',
      '[class*="lesson"]',
      '[class*="chapter"]',
      '[class*="section"]',
      '[class*="unit"]',
      '[class*="item"]',
      '[class*="f-fl"]',
      '[class*="u-"]',
      '[class*="j-"]'
    ];

    const seen = new Set();
    return Array.from(container.querySelectorAll(selectors.join(',')))
      .map(getClickableElement)
      .filter(Boolean)
      .filter((element) => {
        if (seen.has(element)) return false;
        seen.add(element);
        return looksLikeLessonControl(element);
      });
  }

  function sameControl(left, right) {
    if (!left || !right) return false;
    return left === right ||
      left.contains(right) ||
      right.contains(left) ||
      getElementLabel(left) === getElementLabel(right);
  }

  function findNextInLessonContainer(activeElement) {
    let container = activeElement.parentElement;
    for (let depth = 0; container && depth < 6; depth += 1, container = container.parentElement) {
      const candidates = getLessonCandidates(container);
      if (candidates.length < 2 || candidates.length > 40) continue;

      const activeIndex = candidates.findIndex((candidate) => sameControl(candidate, activeElement));
      if (activeIndex < 0) continue;

      return candidates.slice(activeIndex + 1)
        .find((candidate) => !isActiveLessonControl(candidate)) || null;
    }

    return null;
  }

  function findAdjacentLessonControl() {
    const activeSelectors = [
      'button.active',
      'a.active',
      '[role="tab"][aria-selected="true"]',
      '.active',
      '.current',
      '.selected',
      '.z-sel',
      '.z-crt',
      '.u-cur',
      '.cur',
      '.crt',
      '.on',
      '[class*="active"]',
      '[class*="current"]',
      '[class*="selected"]'
    ];

    const activeElements = [
      ...Array.from(document.querySelectorAll(activeSelectors.join(','))).map(getClickableElement),
      ...getLessonCandidates(document.body).filter(isActiveLessonControl)
    ].filter(Boolean)
      .filter(isVisible)
      .filter((element) => !isNonCourseControl(element) && getElementLabel(element).length >= 2);

    for (const activeElement of activeElements) {
      const nextInContainer = findNextInLessonContainer(activeElement);
      if (nextInContainer) return nextInContainer;
    }

    return null;
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
    return candidates.find(looksLikeNextControl) || findAdjacentLessonControl();
  }

  function isInsideAssistant(element) {
    return Boolean(element && element.closest && element.closest('#mooc-study-assistant-panel,#mooc-study-assistant-launcher'));
  }

  function isInDocumentPagerArea(element) {
    if (!element || isInsideAssistant(element)) return false;
    const rect = element.getBoundingClientRect();
    const viewportHeight = window.innerHeight || document.documentElement.clientHeight || 800;
    return rect.top >= viewportHeight * CONFIG.documentPagerMinTopRatio &&
      rect.width > 0 &&
      rect.height > 0;
  }

  function parsePageIndicator(label) {
    const match = cleanText(label).match(/(?:^|\s)(\d{1,3})\s*\/\s*(\d{1,3})(?:\s|$)/);
    if (!match) return null;
    const current = Number(match[1]);
    const total = Number(match[2]);
    if (!Number.isFinite(current) ||
        !Number.isFinite(total) ||
        total <= 1 ||
        current < 1 ||
        current > total) {
      return null;
    }
    return { current, total };
  }

  function findDocumentPageIndicator() {
    const selectors = [
      'button',
      'a',
      '[role="button"]',
      '[onclick]',
      'span',
      'i',
      'em',
      'div'
    ];

    return Array.from(document.querySelectorAll(selectors.join(',')))
      .filter(isVisible)
      .filter(isInDocumentPagerArea)
      .map((element) => {
        const page = parsePageIndicator(getElementLabel(element));
        return page ? { element, rect: element.getBoundingClientRect(), ...page } : null;
      })
      .filter(Boolean)
      .sort((left, right) => right.rect.top - left.rect.top || left.rect.width - right.rect.width)[0] ||
      findSplitDocumentPageIndicator();
  }

  function findSplitDocumentPageIndicator() {
    const activeSelectors = [
      '[aria-current="page"]',
      '[aria-selected="true"]',
      '.active',
      '.current',
      '.selected',
      '.z-crt',
      '.z-sel',
      '.cur',
      '.on'
    ];

    const activeNumericItems = Array.from(document.querySelectorAll(activeSelectors.join(',')))
      .filter(isVisible)
      .filter(isInDocumentPagerArea)
      .filter((element) => /^\d{1,3}$/.test(getElementLabel(element)))
      .map((element) => ({
        element,
        current: Number(getElementLabel(element)),
        rect: element.getBoundingClientRect()
      }));

    for (const item of activeNumericItems) {
      let container = item.element.parentElement;
      for (let depth = 0; container && depth < 5; depth += 1, container = container.parentElement) {
        if (!isVisible(container) || !isInDocumentPagerArea(container)) continue;

        const label = cleanText(container.innerText || container.textContent);
        const explicit = parsePageIndicator(label);
        if (explicit && explicit.current === item.current) {
          return {
            element: container,
            rect: container.getBoundingClientRect(),
            current: explicit.current,
            total: explicit.total
          };
        }

        const numbers = (label.match(/\d{1,3}/g) || []).map(Number);
        const total = numbers.find((value) => value > item.current);
        if (total && total <= 300) {
          return {
            element: item.element,
            rect: item.rect,
            current: item.current,
            total
          };
        }
      }
    }

    return null;
  }

  function findNextReaderArrowControl(pageInfo) {
    if (!pageInfo) return null;

    const indicatorCenterY = pageInfo.rect.top + pageInfo.rect.height / 2;
    const selectors = [
      'button',
      'a',
      '[role="button"]',
      '[onclick]',
      'span',
      'i',
      'em',
      'div'
    ];

    const seen = new Set();
    return Array.from(document.querySelectorAll(selectors.join(',')))
      .filter(isVisible)
      .filter(isInDocumentPagerArea)
      .map((element) => getClickableAncestor(element))
      .filter((element) => {
        if (!element || seen.has(element) || isDisabled(element) || sameControl(element, pageInfo.element)) return false;
        seen.add(element);

        const rect = element.getBoundingClientRect();
        const label = cleanText(getElementLabel(element));
        const classAndId = getClassAndIdChain(element, 3);
        const centerY = rect.top + rect.height / 2;
        const isRightOfIndicator = rect.left >= pageInfo.rect.right - 4 &&
          rect.left - pageInfo.rect.right <= 140 &&
          Math.abs(centerY - indicatorCenterY) <= 48;
        const looksLikeArrow = /^(>|›|»|→|▶|▸|▹)$/.test(label) ||
          /下一页|下页|后一页|下一张/.test(label) ||
          /(next|right|arrow|pager|page)/i.test(classAndId);

        const isSmallClickTarget = rect.width <= 96 && rect.height <= 96;
        const isProbablyArrow = looksLikeArrow || (label === '' && isSmallClickTarget);

        return isRightOfIndicator &&
          isProbablyArrow &&
          !/^\d{1,3}$/.test(label) &&
          rect.width <= 96 &&
          rect.height <= 96 &&
          !parsePageIndicator(label);
      })[0] || null;
  }

  function findNextReaderArrowByPoint(pageInfo) {
    if (!pageInfo || !document.elementFromPoint) return null;

    const centerY = pageInfo.rect.top + pageInfo.rect.height / 2;
    const offsets = [18, 28, 42, 60, 84, 112];
    for (const offset of offsets) {
      const x = Math.min(window.innerWidth - 2, pageInfo.rect.right + offset);
      const y = Math.min(window.innerHeight - 2, Math.max(2, centerY));
      const target = document.elementFromPoint(x, y);
      const clickable = getClickableAncestor(target);
      if (!clickable || sameControl(clickable, pageInfo.element) || isDisabled(clickable) || isInsideAssistant(clickable)) {
        continue;
      }

      const label = cleanText(getElementLabel(clickable));
      if (parsePageIndicator(label) || /^\d{1,3}$/.test(label)) continue;
      if (!isInDocumentPagerArea(clickable)) continue;
      return clickable;
    }

    return null;
  }

  function findNextReaderThumbnailControl(pageInfo) {
    if (!pageInfo) return null;

    const nextPageText = String(pageInfo.current + 1);
    const viewportHeight = window.innerHeight || document.documentElement.clientHeight || 800;
    const indicatorCenterY = pageInfo.rect.top + pageInfo.rect.height / 2;
    const selectors = [
      'button',
      'a',
      '[role="button"]',
      '[onclick]',
      'span',
      'i',
      'em',
      'div',
      'li'
    ];

    const seen = new Set();
    return Array.from(document.querySelectorAll(selectors.join(',')))
      .filter(isVisible)
      .filter(isInDocumentPagerArea)
      .map((element) => {
        const label = cleanText(getElementLabel(element));
        if (label !== nextPageText) return null;

        const clickable = getClickableAncestor(element);
        if (!clickable || seen.has(clickable) || isDisabled(clickable)) return null;
        seen.add(clickable);

        const rect = clickable.getBoundingClientRect();
        const centerY = rect.top + rect.height / 2;
        const classAndId = getClassAndIdChain(clickable, 4);
        const nearReaderPager = rect.top >= viewportHeight * CONFIG.documentPagerMinTopRatio &&
          Math.abs(centerY - indicatorCenterY) <= 180 &&
          rect.width <= 180 &&
          rect.height <= 140;

        if (!nearReaderPager) return null;
        return {
          element: clickable,
          rect,
          score: /(thumb|page|slide|preview|reader|pdf|ppt)/i.test(classAndId) ? 0 : 1
        };
      })
      .filter(Boolean)
      .sort((left, right) => left.score - right.score || right.rect.top - left.rect.top)[0]?.element || null;
  }

  function findNextReaderPagerControl() {
    const pageInfo = findDocumentPageIndicator();
    if (!pageInfo) return null;
    if (isKnownLastDocumentPage(pageInfo)) return null;
    return findNextReaderArrowControl(pageInfo) ||
      findNextReaderArrowByPoint(pageInfo) ||
      findNextReaderThumbnailControl(pageInfo);
  }

  function getDocumentPageState() {
    const pageInfo = findDocumentPageIndicator();
    return {
      signature: getDocumentPageSignature(),
      current: pageInfo ? pageInfo.current : null,
      total: pageInfo ? pageInfo.total : null
    };
  }

  function hasDocumentPageAdvanced(before, after) {
    if (before && after && before.current && after.current && before.total === after.total) {
      return after.current > before.current;
    }

    return Boolean(before && after && before.signature && after.signature && before.signature !== after.signature);
  }

  function canStillTurnDocumentPage(pageState) {
    return Boolean(pageState && pageState.current && pageState.total && pageState.current < pageState.total);
  }

  function isKnownLastDocumentPage(pageState) {
    return Boolean(pageState && pageState.current && pageState.total && pageState.current >= pageState.total);
  }

  function clickElementLikeMouse(element, pointerOptions = {}) {
    if (!element) return false;
    scrollElementIntoView(element, 'center');

    const rect = element.getBoundingClientRect();
    const xRatio = Number.isFinite(pointerOptions.xRatio) ? pointerOptions.xRatio : 0.5;
    const yRatio = Number.isFinite(pointerOptions.yRatio) ? pointerOptions.yRatio : 0.5;
    const clientX = rect.left + rect.width * Math.min(Math.max(xRatio, 0.05), 0.95);
    const clientY = rect.top + rect.height * Math.min(Math.max(yRatio, 0.05), 0.95);
    const options = {
      bubbles: true,
      cancelable: true,
      view: window,
      clientX,
      clientY
    };

    ['pointerdown', 'mousedown', 'mouseup'].forEach((type) => {
      const EventClass = type.startsWith('pointer') && typeof window.PointerEvent === 'function'
        ? window.PointerEvent
        : window.MouseEvent;
      element.dispatchEvent(new EventClass(type, options));
    });

    if (typeof element.click === 'function') {
      element.click();
    }
    return true;
  }

  function scrollElementIntoView(element, block = 'center') {
    if (!element || typeof element.scrollIntoView !== 'function') return false;
    try {
      element.scrollIntoView({ behavior: 'smooth', block, inline: 'nearest' });
      return true;
    } catch (error) {
      element.scrollIntoView();
      return true;
    }
  }

  function scrollContainerToBottom(element) {
    if (!element) return false;
    try {
      if (typeof element.scrollTo === 'function') {
        element.scrollTo({ top: element.scrollHeight, behavior: 'smooth' });
      } else {
        element.scrollTop = element.scrollHeight;
      }
      return true;
    } catch (error) {
      element.scrollTop = element.scrollHeight;
      return true;
    }
  }

  function isScrollableElement(element) {
    if (!element || element === document.documentElement || element === document.body) return false;
    const style = window.getComputedStyle(element);
    const overflowY = `${style.overflowY} ${style.overflow}`;
    return /(auto|scroll|overlay)/i.test(overflowY) &&
      element.scrollHeight > element.clientHeight + 80 &&
      isVisible(element);
  }

  function findDocumentScrollTargets() {
    const selectors = [
      'main',
      'article',
      '.content',
      '.lesson-content',
      '.course-content',
      '[class*="reader"]',
      '[class*="document"]',
      '[class*="doc"]',
      '[class*="pdf"]',
      '[class*="ppt"]',
      '[class*="slide"]',
      '[class*="scroll"]',
      '[class*="view"]',
      '[class*="wrap"]'
    ];

    return Array.from(document.querySelectorAll(selectors.join(',')))
      .filter(isScrollableElement)
      .map((element) => ({
        element,
        rect: element.getBoundingClientRect(),
        score: element.scrollHeight * Math.max(element.clientWidth, 1)
      }))
      .filter((item) => item.rect.height > 180 && item.rect.width > 220)
      .sort((left, right) => right.score - left.score)
      .map((item) => item.element);
  }

  function scrollToDocumentPagerArea() {
    const pageInfo = findDocumentPageIndicator();
    if (pageInfo) {
      return scrollElementIntoView(pageInfo.element, 'center');
    }

    const targets = findDocumentScrollTargets();
    let scrolled = false;
    for (const target of targets.slice(0, 3)) {
      scrolled = scrollContainerToBottom(target) || scrolled;
    }

    try {
      window.scrollTo({
        top: Math.max(document.documentElement.scrollHeight, document.body.scrollHeight),
        behavior: 'smooth'
      });
      scrolled = true;
    } catch (error) {
      window.scrollTo(0, Math.max(document.documentElement.scrollHeight, document.body.scrollHeight));
      scrolled = true;
    }

    return scrolled;
  }

  function scrollToCoursewareNavigation() {
    try {
      window.scrollTo({ top: 0, behavior: 'smooth' });
    } catch (error) {
      window.scrollTo(0, 0);
    }
    return true;
  }

  function findAdjacentDocumentPageControl() {
    const activeSelectors = [
      '[aria-current="page"]',
      '[aria-selected="true"]',
      '.active',
      '.current',
      '.selected',
      '.z-crt',
      '.z-sel',
      '.cur',
      '.on'
    ];

    const activeElements = Array.from(document.querySelectorAll(activeSelectors.join(',')))
      .map(getClickableElement)
      .filter(Boolean)
      .filter((element) => {
        const label = getElementLabel(element);
        return isVisible(element) && /^\d+$/.test(label);
      });

    for (const activeElement of activeElements) {
      let container = activeElement.parentElement;
      for (let depth = 0; container && depth < 4; depth += 1, container = container.parentElement) {
        const pageCandidates = Array.from(container.querySelectorAll('button,a,[role="button"],[onclick],li,span'))
          .map(getClickableElement)
          .filter(Boolean)
          .filter((element, index, list) => list.indexOf(element) === index)
          .filter((element) => isVisible(element) && /^\d+$/.test(getElementLabel(element)));

        const activeIndex = pageCandidates.findIndex((candidate) => sameControl(candidate, activeElement));
        if (activeIndex < 0 || activeIndex >= pageCandidates.length - 1) continue;

        const nextPage = pageCandidates[activeIndex + 1];
        if (!isDisabled(nextPage)) return nextPage;
      }
    }

    return null;
  }

  function findNextDocumentPageControl() {
    if (isKnownLastDocumentPage(findDocumentPageIndicator())) return null;

    const readerPagerControl = findNextReaderPagerControl();
    if (readerPagerControl) return readerPagerControl;

    const selectors = [
      'button',
      'a',
      '[role="button"]',
      '[onclick]',
      '.next-page',
      '.page-next',
      '.pager-next',
      '.pagination-next',
      '.u-next',
      '.j-next'
    ];

    const candidates = Array.from(document.querySelectorAll(selectors.join(',')));
    return candidates.find(looksLikeNextDocumentPageControl) || findAdjacentDocumentPageControl();
  }

  function clickNextControlAfterVideo(video) {
    if (!settings.autoNextAfterVideo || state.pendingClick) return;
    if (!isCoursewareLearningPage()) {
      setStatus('当前不在“课件”内容页面，已停止自动跳转。');
      return;
    }
    if (video && state.completedVideos.has(video)) return;
    if (video) state.completedVideos.add(video);
    state.pendingClick = true;

    window.setTimeout(() => {
      const nextControl = findNextControl();
      if (nextControl) {
        setStatus(`视频已自然结束，进入下一节：${getElementLabel(nextControl) || '下一节'}`);
        log('Clicking next control after ended event:', getElementLabel(nextControl));
        nextControl.click();
      } else {
        setStatus('视频已结束，但没有找到可用的下一节按钮。');
      }
      state.pendingClick = false;
    }, CONFIG.clickDelayMs);
  }

  function shouldAutoNextAfterCompletion(reason) {
    if (settings.autoNextAfterComplete === false) return false;
    return reason !== 'video' || settings.autoNextAfterVideo !== false;
  }

  function getCompletionLabel(reason) {
    if (reason === 'video') return '视频';
    if (reason === 'reading') return '文档';
    return '内容';
  }

  function clickNextControlAfterCompletion(reason, video) {
    if (!shouldAutoNextAfterCompletion(reason) || state.pendingClick) return;
    if (!isCoursewareLearningPage()) {
      setStatus('当前不在“课件”内容页面，已停止自动滑动和自动跳转。');
      return;
    }
    if (reason === 'video' && video && state.completedVideos.has(video)) return;

    const readingKey = reason === 'reading' ? `:${state.readingPageSignature || getDocumentPageSignature()}` : '';
    const completionKey = `${reason}:${location.origin}${location.pathname}${location.hash}${readingKey}`;
    if (state.completedContentKeys.has(completionKey)) return;

    state.pendingClick = true;

    const tryClick = (attempt, pageTurnRetries = 0) => {
      let nextPageControl = reason === 'reading' ? findNextDocumentPageControl() : null;
      const currentPageState = reason === 'reading' && !nextPageControl ? getDocumentPageState() : null;

      if (reason === 'reading' && !nextPageControl && canStillTurnDocumentPage(currentPageState)) {
        state.documentReadyForCoursewareNext = false;
        if (attempt <= CONFIG.pageIndicatorMaxFindAttempts) {
          setStatus(`文档还没翻完（${currentPageState.current}/${currentPageState.total}），继续寻找并点击下一页按钮。`);
          scrollToDocumentPagerArea();
          window.setTimeout(() => tryClick(attempt + 1, pageTurnRetries), CONFIG.readerScrollDelayMs);
          return;
        }

        setStatus(`文档还没翻完（${currentPageState.current}/${currentPageState.total}），但没有找到可点击的下一页按钮，已停止切换课件。`);
        state.readingCompleted = false;
        state.pendingClick = false;
        return;
      }

      if (reason === 'reading' && !nextPageControl && isKnownLastDocumentPage(currentPageState) && attempt < 4) {
        state.documentReadyForCoursewareNext = true;
        setStatus(`已到文档最后一页（${currentPageState.current}/${currentPageState.total}），正在回到顶部查找下一个课件小项。`);
        scrollToCoursewareNavigation();
        window.setTimeout(() => tryClick(4, 0), CONFIG.readerScrollDelayMs);
        return;
      }

      if (reason === 'reading' && !nextPageControl && !state.documentReadyForCoursewareNext && attempt <= CONFIG.pageIndicatorMaxFindAttempts && scrollToDocumentPagerArea()) {
        setStatus(attempt === 1
          ? '正在滑动到课件文档底部翻页栏，准备查找下一页按钮。'
          : '继续在课件文档翻页栏查找下一页按钮。');
        window.setTimeout(() => tryClick(attempt + 1, pageTurnRetries), CONFIG.readerScrollDelayMs);
        return;
      }

      if (reason === 'reading' && !nextPageControl && !state.documentReadyForCoursewareNext) {
        setStatus('还没有确认文档已经到最后一页，已停止寻找下一篇内容，避免提前跳过文档。');
        state.readingCompleted = false;
        state.pendingClick = false;
        return;
      }

      nextPageControl = reason === 'reading' ? findNextDocumentPageControl() : null;
      const allowCoursewareNext = reason !== 'reading' || state.documentReadyForCoursewareNext;

      if (reason === 'reading' && allowCoursewareNext && !nextPageControl && attempt === 4) {
        const visibleCoursewareControl = findNextCoursewareContentControl();
        if (visibleCoursewareControl) {
          state.completedContentKeys.add(completionKey);
          state.documentReadyForCoursewareNext = false;
          setStatus(`当前文档已到最后一页，进入右侧小节菜单的下一项：${getElementLabel(visibleCoursewareControl) || '下一项'}`);
          log('Clicking next subsection after final document page:', getElementLabel(visibleCoursewareControl));
          clickElementLikeMouse(visibleCoursewareControl);
          state.pendingClick = false;
          return;
        }

        if (openCoursewareMenuForCurrentContent()) {
          window.setTimeout(() => tryClick(5, pageTurnRetries), CONFIG.coursewareMenuOpenDelayMs);
          return;
        }
      }

      const nextCoursewareControl = reason === 'reading' && allowCoursewareNext && !nextPageControl && attempt >= 5
        ? findNextCoursewareContentControl()
        : null;

      if (reason === 'reading' &&
          allowCoursewareNext &&
          !nextPageControl &&
          !nextCoursewareControl &&
          attempt === 5 &&
          !hasExpandedCurrentSubsectionMenu() &&
          openCoursewareMenuForCurrentContent()) {
        setStatus('还没有看到右侧小节菜单展开，先再次点击右侧小节按钮。');
        window.setTimeout(() => tryClick(5.5, pageTurnRetries), CONFIG.coursewareMenuOpenDelayMs);
        return;
      }

      if (reason === 'reading' && allowCoursewareNext && !nextPageControl && !nextCoursewareControl && attempt >= 5 && attempt < 6 && openChapterMenu()) {
        window.setTimeout(() => tryClick(6, pageTurnRetries), CONFIG.coursewareMenuOpenDelayMs);
        return;
      }

      const nextChapterControl = reason === 'reading' && allowCoursewareNext && !nextPageControl && !nextCoursewareControl && attempt >= 6
        ? findNextChapterControl()
        : null;

      const nextControl = nextPageControl ||
        nextCoursewareControl ||
        nextChapterControl ||
        (reason === 'reading' ? null : findNextControl());
      if (nextControl) {
        if (nextPageControl) {
          const beforePageState = getDocumentPageState();
          setStatus(`正在点击文档下一页：${getElementLabel(nextControl) || '下一页'}`);
          log('Clicking document next page:', getElementLabel(nextControl), beforePageState);
          clickElementLikeMouse(nextControl);

          window.setTimeout(() => {
            const afterPageState = getDocumentPageState();
            if (hasDocumentPageAdvanced(beforePageState, afterPageState)) {
              setStatus(`已翻到文档第 ${afterPageState.current || ''} 页。`);
              state.readingStartedAt = Date.now();
              state.readingCompleted = false;
              state.documentReadyForCoursewareNext = isKnownLastDocumentPage(afterPageState);
              refreshReadingPageContext();
              state.pendingClick = false;
              return;
            }

            if (pageTurnRetries < CONFIG.pageTurnMaxRetries && canStillTurnDocumentPage(beforePageState)) {
              setStatus('点击下一页后页码没有变化，正在重试翻页。');
              scrollToDocumentPagerArea();
              window.setTimeout(() => tryClick(1, pageTurnRetries + 1), CONFIG.readerScrollDelayMs);
              return;
            }

            if (canStillTurnDocumentPage(beforePageState)) {
              setStatus('下一页按钮没有响应，暂不跳到下一课件，避免漏掉当前文档页。');
              state.readingCompleted = false;
              state.documentReadyForCoursewareNext = false;
              state.pendingClick = false;
              return;
            }

            const lastPageState = isKnownLastDocumentPage(afterPageState)
              ? afterPageState
              : (isKnownLastDocumentPage(beforePageState) ? beforePageState : null);

            if (!lastPageState) {
              setStatus('没有确认文档已经到最后一页，已停止寻找下一篇内容，避免提前跳过文档。');
              state.readingCompleted = false;
              state.documentReadyForCoursewareNext = false;
              state.pendingClick = false;
              return;
            }

            state.documentReadyForCoursewareNext = true;
            setStatus(`已到文档最后一页（${lastPageState.current}/${lastPageState.total}），正在回到顶部课件菜单查找下一项。`);
            scrollToCoursewareNavigation();
            window.setTimeout(() => tryClick(4, 0), CONFIG.readerScrollDelayMs);
          }, CONFIG.pageTurnConfirmDelayMs);
          return;
        }

        if (!nextPageControl) {
          state.completedContentKeys.add(completionKey);
          state.documentReadyForCoursewareNext = false;
        }
        if (reason === 'video' && video) {
          state.completedVideos.add(video);
        }
        if (nextCoursewareControl) {
          setStatus(`当前文档页已停留 ${CONFIG.documentPageDwellSeconds} 秒，进入课件下一项：${getElementLabel(nextControl) || '下一项'}`);
        } else if (nextChapterControl) {
          setStatus(`当前章节已完成，进入课件下一章：${getElementLabel(nextControl) || '下一章'}`);
        } else {
          setStatus(`已完成当前${getCompletionLabel(reason)}，进入下一项：${getElementLabel(nextControl) || '下一项'}`);
        }
        log('Clicking next control after completion:', reason, getElementLabel(nextControl));
        scrollElementIntoView(nextControl, nextPageControl ? 'center' : 'nearest');
        clickElementLikeMouse(nextControl);
        state.pendingClick = false;
        return;
      }

      if (attempt < 7) {
        window.setTimeout(() => tryClick(attempt + 1, pageTurnRetries), 1000);
        return;
      }

      setStatus(`已完成当前${getCompletionLabel(reason)}，但没有在课件章节内容里找到下一项。`);
      state.pendingClick = false;
    };

    window.setTimeout(() => tryClick(1), CONFIG.clickDelayMs);
  }

  function getVideoProgress(video) {
    if (!Number.isFinite(video.duration) || video.duration <= 0) {
      return null;
    }

    return {
      title: getPageTitle(),
      url: location.href,
      currentTime: Math.floor(video.currentTime || 0),
      duration: Math.floor(video.duration || 0),
      savedAt: new Date().toISOString(),
      ended: Boolean(video.ended)
    };
  }

  function saveVideoProgress(video) {
    const progress = getVideoProgress(video);
    if (!progress) return;
    saveJson('videoProgress', progress);
    updateProgress();
  }

  function restoreVideoProgress(video) {
    if (!settings.restoreVideoProgress || video.dataset.moocProgressRestored === 'true') {
      return;
    }

    const progress = loadJson('videoProgress', null);
    if (!progress || !Number.isFinite(video.duration) || video.duration <= 0) {
      return;
    }

    const safeTime = Math.min(progress.currentTime, video.duration - CONFIG.restoreSafeGapSeconds);
    if (safeTime > 5 && safeTime < video.duration - CONFIG.restoreSafeGapSeconds) {
      video.currentTime = safeTime;
      setStatus(`已恢复视频到 ${formatSeconds(safeTime)}。`);
    }
    video.dataset.moocProgressRestored = 'true';
  }

  function bindVideo(video) {
    if (state.watchedVideos.has(video)) return;
    state.watchedVideos.add(video);
    state.currentVideo = video;

    video.addEventListener('loadedmetadata', () => restoreVideoProgress(video));
    video.addEventListener('play', () => {
      state.currentVideo = video;
      restoreVideoProgress(video);
      updateProgress();
    });
    video.addEventListener('pause', () => saveVideoProgress(video));
    video.addEventListener('timeupdate', () => {
      state.currentVideo = video;
      updateProgress();
    });
    video.addEventListener('ended', () => {
      saveVideoProgress(video);
      saveJson('videoComplete', {
        title: getPageTitle(),
        completedAt: new Date().toISOString(),
        url: location.href
      });
      setStatus('视频已自然播放结束。');
      clickNextControlAfterCompletion('video', video);
    });

    if (video.ended) {
      saveVideoProgress(video);
      setStatus('检测到视频已经播放结束，准备进入下一节。');
      clickNextControlAfterCompletion('video', video);
    }

    const timerId = window.setInterval(() => saveVideoProgress(video), CONFIG.saveVideoEveryMs);
    state.videoSaveTimers.set(video, timerId);
  }

  function scanVideos() {
    document.querySelectorAll('video').forEach(bindVideo);
  }

  function getReadableRoot() {
    const candidates = CONFIG.articleSelectors
      .flatMap((selector) => Array.from(document.querySelectorAll(selector)))
      .filter(isVisible)
      .map((element) => ({
        element,
        textLength: cleanText(element.innerText || element.textContent).length,
        rect: element.getBoundingClientRect()
      }))
      .filter((item) => item.textLength > 300 && item.rect.height > 200)
      .sort((a, b) => b.textLength - a.textLength);

    return candidates[0] ? candidates[0].element : document.body;
  }

  function getDocumentPageSignature() {
    const root = getReadableRoot();
    const text = cleanText(root.innerText || root.textContent);
    const visiblePageMarker = Array.from(document.querySelectorAll('[aria-current="page"],[aria-selected="true"],.active,.current,.selected,.z-crt,.z-sel,.cur,.on'))
      .filter(isVisible)
      .map(getElementLabel)
      .filter(Boolean)
      .slice(0, 5)
      .join('|');

    return [
      location.origin,
      location.pathname,
      location.hash,
      visiblePageMarker,
      text.length,
      text.slice(0, 160),
      text.slice(-160)
    ].join('::');
  }

  function refreshReadingPageContext() {
    const signature = getDocumentPageSignature();
    if (state.readingPageSignature && state.readingPageSignature !== signature) {
      state.readingStartedAt = Date.now();
      state.readingCompleted = false;
      state.documentReadyForCoursewareNext = false;
      setStatus('检测到文档页面变化，开始记录新页面阅读进度。');
    }
    state.readingPageSignature = signature;
  }

  function getReadingPercent() {
    const root = getReadableRoot();
    const rect = root.getBoundingClientRect();
    const viewportHeight = window.innerHeight || document.documentElement.clientHeight;
    const total = Math.max(rect.height - viewportHeight, 1);
    const read = Math.min(Math.max(-rect.top, 0), total);
    return Math.round((read / total) * 100);
  }

  function updateReadingProgress() {
    const hasVideo = Boolean(document.querySelector('video'));
    const inCoursewarePage = isCoursewareLearningPage();

    if (!hasVideo && inCoursewarePage) {
      refreshReadingPageContext();
    }

    const percent = getReadingPercent();
    const dwellSeconds = Math.floor((Date.now() - state.readingStartedAt) / 1000);

    if (!hasVideo &&
        inCoursewarePage &&
        !state.readingCompleted &&
        dwellSeconds >= CONFIG.documentPageDwellSeconds) {
      state.readingCompleted = true;
      saveJson('readingComplete', {
        title: getPageTitle(),
        percent,
        dwellSeconds,
        completedAt: new Date().toISOString(),
        url: location.href
      });
      setStatus(`当前文档页已停留 ${CONFIG.documentPageDwellSeconds} 秒，准备翻页或进入课件下一项。`);
      clickNextControlAfterCompletion('reading', null);
    }

    saveJson('readingProgress', {
      title: getPageTitle(),
      percent,
      dwellSeconds,
      savedAt: new Date().toISOString(),
      url: location.href
    });

    updateProgress();
  }

  function collectHeadings() {
    const root = getReadableRoot();
    return Array.from(root.querySelectorAll('h1,h2,h3,h4,[role="heading"]'))
      .map((element) => cleanText(element.textContent))
      .filter((text, index, list) => text && text.length <= 100 && list.indexOf(text) === index)
      .slice(0, 12);
  }

  function collectKeyParagraphs() {
    const root = getReadableRoot();
    return Array.from(root.querySelectorAll('p,li'))
      .map((element) => cleanText(element.textContent))
      .filter((text) => text.length >= 30 && text.length <= 240)
      .slice(0, 8);
  }

  function buildStudyBrief() {
    const headings = collectHeadings();
    const paragraphs = collectKeyParagraphs();
    const lines = [
      `# ${getPageTitle()}`,
      '',
      '## 重点标题',
      ...(headings.length ? headings.map((text) => `- ${text}`) : ['- 暂未识别到明显标题']),
      '',
      '## 关键段落',
      ...(paragraphs.length ? paragraphs.map((text) => `- ${text}`) : ['- 暂未识别到正文段落']),
      '',
      '## 我的笔记',
      getNotes() || '- '
    ];
    return lines.join('\n');
  }

  function getSpeechText() {
    const root = getReadableRoot();
    const selectedText = cleanText(window.getSelection && window.getSelection().toString());
    const text = selectedText || cleanText(root.innerText || root.textContent);
    return text.slice(0, CONFIG.maxSpeechChars);
  }

  function toggleSpeech() {
    if (!('speechSynthesis' in window) || !('SpeechSynthesisUtterance' in window)) {
      setStatus('当前浏览器不支持文字朗读。');
      return;
    }

    if (state.speaking) {
      window.speechSynthesis.cancel();
      state.speaking = false;
      updateSpeechButton();
      setStatus('已停止朗读。');
      return;
    }

    const text = getSpeechText();
    if (!text) {
      setStatus('没有找到可朗读的正文。');
      return;
    }

    const utterance = new SpeechSynthesisUtterance(text);
    utterance.lang = document.documentElement.lang || 'zh-CN';
    utterance.rate = 1;
    utterance.onend = () => {
      state.speaking = false;
      updateSpeechButton();
      setStatus('朗读结束。');
    };
    utterance.onerror = () => {
      state.speaking = false;
      updateSpeechButton();
      setStatus('朗读被中断。');
    };

    state.speaking = true;
    updateSpeechButton();
    window.speechSynthesis.speak(utterance);
    setStatus('正在朗读当前文档或选中文字。');
  }

  function getNotes() {
    return localStorage.getItem(storageKey('notes')) || '';
  }

  function saveNotes(value) {
    localStorage.setItem(storageKey('notes'), value);
  }

  function insertTimestampNote() {
    const video = state.currentVideo || document.querySelector('video');
    const stamp = video ? formatSeconds(video.currentTime || 0) : new Date().toLocaleTimeString();
    const line = `\n- [${stamp}] `;
    const input = state.notesInput;
    if (!input) return;
    const start = input.selectionStart || input.value.length;
    const end = input.selectionEnd || input.value.length;
    input.value = `${input.value.slice(0, start)}${line}${input.value.slice(end)}`;
    input.focus();
    input.selectionStart = input.selectionEnd = start + line.length;
    saveNotes(input.value);
    setStatus('已插入时间戳笔记。');
  }

  async function copyStudyBrief() {
    const brief = buildStudyBrief();
    try {
      await navigator.clipboard.writeText(brief);
      setStatus('学习摘要和笔记已复制。');
    } catch (error) {
      window.prompt('复制下面的学习摘要：', brief);
    }
  }

  function formatSeconds(seconds) {
    const total = Math.max(0, Math.floor(seconds || 0));
    const minutes = Math.floor(total / 60);
    const rest = total % 60;
    return `${minutes}:${String(rest).padStart(2, '0')}`;
  }

  function setStatus(message) {
    if (state.statusNode) {
      state.statusNode.textContent = message;
    }
    log(message);
  }

  function updateProgress() {
    if (!state.progressNode) return;

    const video = state.currentVideo || document.querySelector('video');
    const videoText = video && Number.isFinite(video.duration) && video.duration > 0
      ? `视频 ${formatSeconds(video.currentTime)} / ${formatSeconds(video.duration)}`
      : '视频 未检测到';
    const reading = loadJson('readingProgress', null);
    const readingText = reading
      ? `文档 ${reading.percent}% · 本页 ${reading.dwellSeconds || 0}s`
      : '文档 未记录';

    state.progressNode.textContent = `${videoText} · ${readingText}`;
  }

  function updateSpeechButton() {
    if (state.speechButton) {
      state.speechButton.textContent = state.speaking ? '停止朗读' : '朗读文本';
    }
  }

  function createButton(label, onClick) {
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = label;
    button.addEventListener('click', onClick);
    return button;
  }

  function createToggle(label, key) {
    const wrapper = document.createElement('label');
    const checkbox = document.createElement('input');
    const text = document.createElement('span');
    checkbox.type = 'checkbox';
    checkbox.checked = Boolean(settings[key]);
    text.textContent = label;
    checkbox.addEventListener('change', () => {
      settings[key] = checkbox.checked;
      saveSettings();
      setStatus(`${label}：${checkbox.checked ? '开启' : '关闭'}`);
    });
    wrapper.append(checkbox, text);
    return wrapper;
  }

  function createLauncher() {
    if (state.launcher || state.panel) return;

    const button = document.createElement('button');
    button.type = 'button';
    button.id = 'mooc-study-assistant-launcher';
    button.textContent = '学';
    button.title = '打开 MOOC 学习助手';
    Object.assign(button.style, {
      position: 'fixed',
      right: '16px',
      bottom: '16px',
      zIndex: '2147483647',
      width: '44px',
      height: '44px',
      border: '1px solid #16a34a',
      borderRadius: '22px',
      background: '#22c55e',
      color: '#ffffff',
      font: '700 18px/1 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
      boxShadow: '0 10px 24px rgba(15, 23, 42, 0.2)',
      cursor: 'pointer'
    });
    button.addEventListener('click', () => {
      settings.showPanel = true;
      saveSettings();
      button.remove();
      state.launcher = null;
      createPanel();
    });

    document.documentElement.append(button);
    state.launcher = button;
  }

  function createPanel() {
    if (state.panel) return;
    if (!settings.showPanel) {
      createLauncher();
      return;
    }
    if (state.launcher) {
      state.launcher.remove();
      state.launcher = null;
    }

    let style = document.getElementById('mooc-study-assistant-style');
    if (!style) {
      style = document.createElement('style');
      style.id = 'mooc-study-assistant-style';
      style.textContent = `
      #mooc-study-assistant-panel {
        position: fixed;
        right: 16px;
        bottom: 16px;
        z-index: 2147483647;
        width: min(360px, calc(100vw - 32px));
        box-sizing: border-box;
        padding: 12px;
        color: #1f2937;
        background: #ffffff;
        border: 1px solid #d1d5db;
        border-radius: 8px;
        box-shadow: 0 12px 32px rgba(15, 23, 42, 0.18);
        font: 13px/1.4 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      }
      #mooc-study-assistant-panel * {
        box-sizing: border-box;
      }
      #mooc-study-assistant-panel header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 8px;
        margin-bottom: 8px;
        font-weight: 700;
      }
      #mooc-study-assistant-panel .mooc-progress,
      #mooc-study-assistant-panel .mooc-status {
        margin: 6px 0;
        color: #4b5563;
      }
      #mooc-study-assistant-panel .mooc-actions {
        display: grid;
        grid-template-columns: 1fr 1fr;
        gap: 6px;
        margin: 8px 0;
      }
      #mooc-study-assistant-panel button {
        min-height: 30px;
        border: 1px solid #cbd5e1;
        border-radius: 6px;
        background: #f8fafc;
        color: #111827;
        cursor: pointer;
      }
      #mooc-study-assistant-panel button:hover {
        background: #eef2f7;
      }
      #mooc-study-assistant-panel label {
        display: flex;
        align-items: center;
        gap: 6px;
        margin: 5px 0;
      }
      #mooc-study-assistant-panel textarea {
        width: 100%;
        min-height: 92px;
        resize: vertical;
        margin-top: 8px;
        padding: 8px;
        border: 1px solid #cbd5e1;
        border-radius: 6px;
        color: #111827;
        background: #ffffff;
        font: inherit;
      }
      #mooc-study-assistant-panel .mooc-status {
        min-height: 18px;
        color: #2563eb;
      }
    `;
    }

    const panel = document.createElement('section');
    panel.id = 'mooc-study-assistant-panel';
    panel.innerHTML = '<header><span>MOOC 学习助手</span></header>';

    const closeButton = createButton('收起', () => {
      panel.remove();
      state.panel = null;
      settings.showPanel = false;
      saveSettings();
      createLauncher();
    });
    panel.querySelector('header').append(closeButton);

    state.progressNode = document.createElement('div');
    state.progressNode.className = 'mooc-progress';

    state.statusNode = document.createElement('div');
    state.statusNode.className = 'mooc-status';
    state.statusNode.textContent = '已准备记录真实学习进度。';

    const toggles = document.createElement('div');
    toggles.append(
      createToggle('完成后下一节', 'autoNextAfterComplete'),
      createToggle('恢复视频进度', 'restoreVideoProgress')
    );

    const actions = document.createElement('div');
    actions.className = 'mooc-actions';
    state.speechButton = createButton('朗读文本', toggleSpeech);
    actions.append(
      state.speechButton,
      createButton('时间戳笔记', insertTimestampNote),
      createButton('复制摘要', copyStudyBrief),
      createButton('刷新进度', () => {
        updateReadingProgress();
        updateProgress();
        setStatus('进度已刷新。');
      })
    );

    state.notesInput = document.createElement('textarea');
    state.notesInput.placeholder = '写下本节笔记，内容会保存在本机浏览器。';
    state.notesInput.value = getNotes();
    state.notesInput.addEventListener('input', () => saveNotes(state.notesInput.value));

    panel.append(state.progressNode, state.statusNode, toggles, actions, state.notesInput);
    document.documentElement.append(style, panel);
    state.panel = panel;
    updateProgress();
  }

  function resetForRouteChange() {
    state.lastUrl = location.href;
    state.pendingClick = false;
    state.currentVideo = null;
    state.readingStartedAt = Date.now();
    state.readingCompleted = false;
    state.documentReadyForCoursewareNext = false;
    if (state.notesInput) {
      state.notesInput.value = getNotes();
    }
    if (state.speaking && 'speechSynthesis' in window) {
      window.speechSynthesis.cancel();
      state.speaking = false;
      updateSpeechButton();
    }
    setStatus('已切换页面，重新记录本节学习进度。');
  }

  function scheduleScan() {
    if (state.scheduledScanId) return;
    state.scheduledScanId = window.setTimeout(() => {
      state.scheduledScanId = 0;
      scanVideos();
      updateProgress();
    }, CONFIG.mutationDebounceMs);
  }

  function scheduleReadingProgress() {
    if (state.scheduledReadingId) return;
    state.scheduledReadingId = window.setTimeout(() => {
      state.scheduledReadingId = 0;
      updateReadingProgress();
    }, CONFIG.scrollDebounceMs);
  }

  const observer = new MutationObserver(scheduleScan);
  observer.observe(document.documentElement, { childList: true, subtree: true });

  window.addEventListener('scroll', scheduleReadingProgress, { passive: true });
  window.addEventListener('beforeunload', () => {
    const video = state.currentVideo || document.querySelector('video');
    if (video) saveVideoProgress(video);
    updateReadingProgress();
  });

  window.setInterval(() => {
    if (state.lastUrl !== location.href) {
      resetForRouteChange();
    }
    scanVideos();
    updateProgress();
  }, CONFIG.scanIntervalMs);

  window.setInterval(updateReadingProgress, CONFIG.readingIntervalMs);

  scanVideos();
  createPanel();
  updateReadingProgress();
})();
