// ==UserScript==
// @name         MOOC Study Assistant
// @namespace    https://github.com/qwdcvj/mooc-self-study
// @version      0.2.6
// @description  Save real learning progress, help read documents aloud, take notes, and go next only after a video naturally ends.
// @author       qwdcvj
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
    readingIntervalMs: 10000,
    mutationDebounceMs: 800,
    scrollDebounceMs: 500,
    saveVideoEveryMs: 5000,
    restoreSafeGapSeconds: 15,
    readingCompletePercent: 95,
    readingDwellSeconds: 30,
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
      /完成|已学完|提交|交卷|签到|打卡|考试|测验|作业|答题|评价/,
      /finish|complete|submit|exam|quiz|test|homework|assignment/i
    ],
    nonDocumentNextPatterns: [
      /下一[章节课讲个]/,
      /继续学习/,
      /继续播放/,
      /next lesson|next chapter|continue/i
    ],
    nonCourseControlPatterns: [
      /^课件$/,
      /讨论|讨论区|问答|答疑|评论|论坛|公告|通知|消息|分享|评价课程|评分|老师提问|提问|客服|帮助/,
      /discuss|forum|comment|notice|message|share|rating|review|question|support|help/i
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
    if (reason === 'video' && video && state.completedVideos.has(video)) return;

    const readingKey = reason === 'reading' ? `:${state.readingPageSignature || getDocumentPageSignature()}` : '';
    const completionKey = `${reason}:${location.origin}${location.pathname}${location.hash}${readingKey}`;
    if (state.completedContentKeys.has(completionKey)) return;

    state.pendingClick = true;

    const tryClick = (attempt) => {
      const nextPageControl = reason === 'reading' ? findNextDocumentPageControl() : null;
      const nextControl = nextPageControl || findNextControl();
      if (nextControl) {
        state.completedContentKeys.add(completionKey);
        if (reason === 'video' && video) {
          state.completedVideos.add(video);
        }
        if (nextPageControl) {
          setStatus(`已读完当前文档页，翻到下一页：${getElementLabel(nextControl) || '下一页'}`);
          state.readingStartedAt = Date.now();
          state.readingCompleted = false;
        } else {
          setStatus(`已完成当前${getCompletionLabel(reason)}，进入下一项：${getElementLabel(nextControl) || '下一项'}`);
        }
        log('Clicking next control after completion:', reason, getElementLabel(nextControl));
        nextControl.click();
        state.pendingClick = false;
        return;
      }

      if (attempt < 4) {
        window.setTimeout(() => tryClick(attempt + 1), 1000);
        return;
      }

      setStatus(`已完成当前${getCompletionLabel(reason)}，但没有找到下一项按钮或课程标签。`);
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
    if (!document.querySelector('video')) {
      refreshReadingPageContext();
    }

    const percent = getReadingPercent();
    const dwellSeconds = Math.floor((Date.now() - state.readingStartedAt) / 1000);

    if (!document.querySelector('video') &&
        !state.readingCompleted &&
        percent >= CONFIG.readingCompletePercent &&
        dwellSeconds >= CONFIG.readingDwellSeconds) {
      state.readingCompleted = true;
      saveJson('readingComplete', {
        title: getPageTitle(),
        percent,
        completedAt: new Date().toISOString(),
        url: location.href
      });
      setStatus('已记录本地阅读完成。平台完成状态仍由你真实学习行为决定。');
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
    const readingText = reading ? `阅读 ${reading.percent}%` : '阅读 未记录';

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
