'use strict';
/**
 * 谛听轻量探针（DiTing）前端国际化（i18n）核心模块
 * 用法：
 *   1. HTML: <span data-i18n="nav.dashboard"></span>
 *   2. JS  : t('nav.dashboard')
 *   3. 带参: t('dashboard.card_days_left', { days: 5 }) → "剩 5 天"
 */
(function (root) {
  var _locale = 'zh-CN';
  var _messages = {};
  var _loaded = false;
  var _callbacks = [];

  // 获取当前语言：localStorage > 浏览器默认 > zh-CN
  function detectLocale() {
    var saved = (typeof localStorage !== 'undefined') ? localStorage.getItem('locale') : null;
    if (saved) return saved;
    var navLang = (typeof navigator !== 'undefined' && navigator.language) || 'zh-CN';
    return navLang.startsWith('zh') ? 'zh-CN' : 'en';
  }

  // 加载语言文件
  function loadLocale(locale, callback) {
    _locale = locale || detectLocale();
    var url = '/i18n/' + _locale + '.json';
    fetch(url, { cache: 'no-store' })
      .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
      .then(function (msgs) {
        _messages = msgs;
        _loaded = true;
        // 持久化选择
        try { localStorage.setItem('locale', _locale); } catch (e) {}
        // 设置 <html lang>
        if (typeof document !== 'undefined') document.documentElement.setAttribute('lang', _locale);
        if (callback) callback(_locale);
        // 通知等待者
        while (_callbacks.length) { _callbacks.shift()(_locale); }
      })
      .catch(function (e) {
        console.warn('[i18n] failed to load ' + url + ', fallback zh-CN', e);
        if (_locale !== 'zh-CN') { loadLocale('zh-CN', callback); }
        else { _messages = {}; _loaded = true; if (callback) callback(_locale); }
      });
  }

  // 翻译函数：t('key', { name: 'xxx' }) → 替换 {name} 占位符
  function t(key, params) {
    var msg = _messages[key];
    if (msg == null) return key; // 找不到 key 时返回 key 本身（便于排查）
    if (params) {
      msg = msg.replace(/\{(\w+)\}/g, function (m, k) {
        return params[k] != null ? params[k] : m;
      });
    }
    return msg;
  }

  // 获取当前语言
  function getLocale() { return _locale; }

  // 切换语言
  function setLocale(locale, callback) {
    if (locale === _locale) { if (callback) callback(locale); return; }
    _loaded = false;
    loadLocale(locale, callback);
  }

  // 加载完成后执行
  function ready(callback) {
    if (_loaded) return callback(_locale);
    _callbacks.push(callback);
  }

  // 应用翻译到 DOM（所有带 data-i18n 属性的元素）
  function applyDOM() {
    if (typeof document === 'undefined') return;
    var els = document.querySelectorAll('[data-i18n]');
    for (var i = 0; i < els.length; i++) {
      var el = els[i];
      var key = el.getAttribute('data-i18n');
      var translated = t(key);
      // 如果有 data-i18n-html 属性，使用 innerHTML；否则用 textContent
      if (el.hasAttribute('data-i18n-html')) {
        el.innerHTML = translated;
      } else {
        el.textContent = translated;
      }
    }
    // 翻译 placeholder
    var phEls = document.querySelectorAll('[data-i18n-ph]');
    for (var j = 0; j < phEls.length; j++) {
      var phEl = phEls[j];
      var phKey = phEl.getAttribute('data-i18n-ph');
      phEl.setAttribute('placeholder', t(phKey));
    }
    // 翻译 title
    var titleEls = document.querySelectorAll('[data-i18n-title]');
    for (var k = 0; k < titleEls.length; k++) {
      var tEl = titleEls[k];
      var tKey = tEl.getAttribute('data-i18n-title');
      tEl.setAttribute('title', t(tKey));
    }
  }

  // 导出
  root.I18N = {
    t: t,
    getLocale: getLocale,
    setLocale: setLocale,
    loadLocale: loadLocale,
    applyDOM: applyDOM,
    ready: ready
  };

  // 自动初始化
  loadLocale(detectLocale());
})(typeof window !== 'undefined' ? window : this);
