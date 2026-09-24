// ==UserScript==
// @name         MoeWalls Preview & Download
// @namespace    naXim Labs
// @author       naXim Labs (MoeWalls Tools)
// @version      9.2
// @description  Download + Live Preview. Regex-based video URL extraction — immune to DOM selector failures. Zero cache collisions. Stale-request guard. Designed for reliable everyday use.
// @license      MIT
// @homepageURL  https://github.com/0naXim0/moewalls-preview-download
// @supportURL   https://github.com/0naXim0/moewalls-preview-download/issues
// @match        https://moewalls.com/*
// @grant        GM_xmlhttpRequest
// @grant        GM_addStyle
// @grant        GM_setValue
// @grant        GM_getValue
// @connect      moewalls.com
// @connect      go.moewalls.com
// @icon         https://moewalls.com/favicon.ico
// @downloadURL  https://cdn.jsdelivr.net/gh/0naXim0/moewalls-preview-download@main/moewalls-preview-download.user.js
// @updateURL    https://cdn.jsdelivr.net/gh/0naXim0/moewalls-preview-download@main/moewalls-preview-download.user.js
// ==/UserScript==

(function () {
    'use strict';

    // ══════════════════════════════════════════════════════
    //  CONSTANTS
    // ══════════════════════════════════════════════════════
    const DL_BASE   = 'https://go.moewalls.com/download.php?video=';
    const CACHE_TTL = 20 * 60 * 1000;
    const CACHE_PFX = 'mw91_'; // new prefix — clears all stale v7/v8/v9 entries

    // ══════════════════════════════════════════════════════
    //  URL NORMALIZER
    //  Always resolves to absolute URL and strips trailing
    //  slash so every cache/inFlight lookup uses exact same key.
    // ══════════════════════════════════════════════════════
    const normalizeUrl = (href) => {
        try {
            return new URL(href, 'https://moewalls.com/').href.replace(/\/$/, '');
        } catch { return href; }
    };

    // ══════════════════════════════════════════════════════
    //  CACHE KEY — djb2 hash of full normalized URL
    //  No truncation = zero collision between wallpaper URLs.
    // ══════════════════════════════════════════════════════
    const djb2 = (str) => {
        let h = 5381;
        for (let i = 0; i < str.length; i++) {
            h = ((h << 5) + h) ^ str.charCodeAt(i);
            h = h >>> 0;
        }
        return h.toString(36);
    };

    const cKey = (url) => CACHE_PFX + djb2(normalizeUrl(url));

    const cGet = (url) => {
        try {
            const raw = GM_getValue(cKey(url));
            if (!raw) return null;
            const obj = JSON.parse(raw);
            if (Date.now() - obj.ts >= CACHE_TTL) return null;
            return obj;
        } catch { return null; }
    };

    const cSet = (url, data) => {
        try { GM_setValue(cKey(url), JSON.stringify({ ...data, ts: Date.now() })); }
        catch {}
    };

    const cDel = (url) => {
        try { GM_setValue(cKey(url), null); } catch {}
    };

    // ══════════════════════════════════════════════════════
    //  IN-FLIGHT DEDUP  (keyed by normalized URL)
    // ══════════════════════════════════════════════════════
    const inFlight = new Map();

    // Resolves with { doc, rawHtml } — raw HTML is needed
    // for regex-based video URL extraction (see below).
    const fetchPage = (rawUrl) => {
        const url = normalizeUrl(rawUrl);
        if (inFlight.has(url)) return inFlight.get(url);
        const p = new Promise((resolve, reject) => {
            GM_xmlhttpRequest({
                method: 'GET',
                url,
                headers: {
                    'User-Agent':      navigator.userAgent,
                    'Referer':         'https://moewalls.com/',
                    'Accept':          'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
                    'Accept-Language': 'en-US,en;q=0.9',
                    'Cache-Control':   'no-cache',
                },
                timeout: 25000,
                onload: (r) => {
                    inFlight.delete(url);
                    if (r.status >= 400) return reject(new Error('HTTP ' + r.status));
                    try {
                        const rawHtml = r.responseText;
                        const doc     = new DOMParser().parseFromString(rawHtml, 'text/html');
                        resolve({ doc, rawHtml });
                    } catch (e) { reject(e); }
                },
                onerror:   () => { inFlight.delete(url); reject(new Error('Network error')); },
                ontimeout: () => { inFlight.delete(url); reject(new Error('Timeout')); },
            });
        });
        inFlight.set(url, p);
        return p;
    };

    // ══════════════════════════════════════════════════════
    //  EXTRACT PAGE DATA FROM FETCHED PAGE
    // ══════════════════════════════════════════════════════
    const extractPageData = ({ doc, rawHtml }) => {

        // ── Download token (DOM is fine for this) ──
        const dlEl  = doc.querySelector('#moe-download, a.lcc-wall[data-url], a[data-url][data-id]');
        const token = dlEl?.getAttribute('data-url') || null;

        // ── Video URL via REGEX on raw HTML ──
        let videoUrl = null;

        const srcMatch = rawHtml.match(
            /[<\s]source[^>]+src=["']([^"']*\/wp-content\/uploads\/[^"']+\.(?:webm|mp4))[^"']*["']/i
        );

        const vidMatch = rawHtml.match(
            /[<\s]video[^>]+src=["']([^"']*\/wp-content\/uploads\/[^"']+\.(?:webm|mp4))[^"']*["']/i
        );

        const anyMatch = rawHtml.match(
            /["']((?:https?:\/\/moewalls\.com)?\/wp-content\/uploads\/[^"']+\.(?:webm|mp4))["']/i
        );

        const bestMatch = srcMatch?.[1] || vidMatch?.[1] || anyMatch?.[1] || null;

        if (bestMatch) {
            videoUrl = bestMatch.startsWith('http')
                ? bestMatch
                : 'https://moewalls.com' + bestMatch;
        }

        return { token, videoUrl };
    };

    // ══════════════════════════════════════════════════════
    //  GET PAGE DATA  (cache-first, single auto-retry)
    // ══════════════════════════════════════════════════════
    const getPageData = async (pageUrl, forceRefresh = false) => {
        const url = normalizeUrl(pageUrl);
        if (!forceRefresh) {
            const cached = cGet(url);
            if (cached && (cached.token || cached.videoUrl)) return cached;
        } else {
            cDel(url);
        }
        const result = await fetchPage(url);
        const data   = extractPageData(result);
        if (data.token || data.videoUrl) cSet(url, data);
        return data;
    };

    // ══════════════════════════════════════════════════════
    //  NATIVE BROWSER DOWNLOAD
    // ══════════════════════════════════════════════════════
    const nativeDownload = (url, filename) => {
        const a = document.createElement('a');
        a.href  = url;
        a.download    = filename;
        a.target      = '_blank';
        a.rel         = 'noopener noreferrer';
        a.style.cssText = 'position:fixed;opacity:0;pointer-events:none';
        document.body.appendChild(a);
        a.click();
        setTimeout(() => { try { a.remove(); } catch {} }, 300);
    };

    const buildFilename = (pageUrl) => {
        const slug = normalizeUrl(pageUrl).split('/').pop() || 'wallpaper';
        return slug.replace(/[\\/:*?"<>|]/g, '_') + '.mp4';
    };

    // ══════════════════════════════════════════════════════
    //  MASTER DOWNLOAD  (auto-retry once on bad cache)
    // ══════════════════════════════════════════════════════
    const masterDownload = async (pageUrl, onStatus) => {
        onStatus('loading');
        let data;
        try { data = await getPageData(pageUrl); }
        catch (e) { console.error('[MoeWalls Preview & Download] DL fetch failed:', e); onStatus('err'); return; }

        if (!data?.token) {
            try { data = await getPageData(pageUrl, true); }
            catch { onStatus('err'); return; }
            if (!data?.token) { onStatus('err'); return; }
        }

        nativeDownload(DL_BASE + data.token, buildFilename(pageUrl));
        onStatus('ok');
    };

    // ══════════════════════════════════════════════════════
    //  PREVIEW OVERLAY
    //  Close via Esc key or clicking the dark backdrop.
    // ══════════════════════════════════════════════════════
    let activeOverlay = null;

    const closePreview = () => {
        if (!activeOverlay) return;
        const el = activeOverlay;
        activeOverlay = null;
        el._onKey && document.removeEventListener('keydown', el._onKey);
        el.style.animation = 'mw-bg-out 0.14s ease forwards';
        setTimeout(() => { try { el.remove(); } catch {} }, 130);
    };

    const showPreview = (videoUrl) => {
        closePreview();

        const wrap = document.createElement('div');
        wrap.id    = 'mw-preview-wrap';

        const card = document.createElement('div');
        card.id    = 'mw-preview-card';

        const vid       = document.createElement('video');
        // Set src directly — do NOT set a type attribute.
        // The page source uses type="video/mp4" on a .webm file
        // (a bug on the site's side); omitting type lets the
        // browser sniff the codec correctly and always plays.
        vid.src         = videoUrl;
        vid.autoplay    = true;
        vid.loop        = true;
        vid.muted       = true;
        vid.controls    = true;
        vid.playsInline = true;

        card.appendChild(vid);
        wrap.appendChild(card);
        document.body.appendChild(wrap);

        wrap.addEventListener('click', (e) => { if (e.target === wrap) closePreview(); });

        const onKey = (e) => { if (e.key === 'Escape') closePreview(); };
        document.addEventListener('keydown', onKey);
        wrap._onKey   = onKey;
        activeOverlay = wrap;

        vid.play().catch(() => {});
    };

    // ══════════════════════════════════════════════════════
    //  MASTER PREVIEW
    // ══════════════════════════════════════════════════════
    let previewReqId = 0;

    const masterPreview = async (pageUrl, onStatus) => {
        const myId = ++previewReqId;
        onStatus('loading');

        let data;
        try { data = await getPageData(pageUrl); }
        catch (e) {
            if (previewReqId !== myId) return;
            console.error('[MoeWalls Preview & Download] Preview fetch failed:', e);
            onStatus('err');
            return;
        }

        if (previewReqId !== myId) return; // superseded

        if (!data?.videoUrl) {
            console.warn('[MoeWalls Preview & Download] videoUrl missing — retrying fresh…');
            try { data = await getPageData(pageUrl, true); } catch { /* fall through */ }
            if (previewReqId !== myId) return;
            if (!data?.videoUrl) { onStatus('err'); return; }
        }

        onStatus('idle');
        showPreview(data.videoUrl);
    };

    // ══════════════════════════════════════════════════════
    //  BUTTON STATE MACHINE
    // ══════════════════════════════════════════════════════
    const applyState = (btn, state, idleIcon) => {
        btn.classList.remove('s-loading', 's-ok', 's-err');
        switch (state) {
            case 'loading':
                btn.classList.add('s-loading');
                btn.innerHTML = SPIN;
                break;
            case 'ok':
                btn.classList.add('s-ok');
                btn.innerHTML = SVG.ok;
                setTimeout(() => { if (btn.isConnected) { btn.classList.remove('s-ok'); btn.innerHTML = idleIcon; } }, 2400);
                break;
            case 'err':
                btn.classList.add('s-err');
                btn.innerHTML = SVG.err;
                setTimeout(() => { if (btn.isConnected) { btn.classList.remove('s-err'); btn.innerHTML = idleIcon; } }, 2400);
                break;
            default:
                btn.innerHTML = idleIcon;
        }
    };

    // ══════════════════════════════════════════════════════
    //  SVG ICONS
    // ══════════════════════════════════════════════════════
    const SVG = {
        dl:      `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="rgba(255,255,255,0.92)" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>`,
        ok:      `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="rgba(255,255,255,0.95)" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>`,
        err:     `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="rgba(255,255,255,0.95)" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>`,
        preview: `<svg width="14" height="14" viewBox="0 0 24 24" fill="rgba(255,255,255,0.92)" stroke="none"><polygon points="5 3 19 12 5 21 5 3"/></svg>`,
    };
    const SPIN = `<span class="mw-spin"></span>`;

    // ══════════════════════════════════════════════════════
    //  STYLES
    // ══════════════════════════════════════════════════════
    GM_addStyle(`
        .mw-btns {
            position:       absolute !important;
            bottom:         10px !important;
            right:          10px !important;
            z-index:        9999 !important;
            display:        flex !important;
            flex-direction: column !important;
            align-items:    center !important;
            gap:            6px !important;
            pointer-events: none !important;
            opacity:        0 !important;
            transform:      scale(0.72) !important;
            transition:
                opacity   0.22s cubic-bezier(0.34,1.56,0.64,1),
                transform 0.22s cubic-bezier(0.34,1.56,0.64,1) !important;
        }
        .g1-frame:hover .mw-btns {
            opacity:        1 !important;
            transform:      scale(1) !important;
            pointer-events: all !important;
        }
        .mw-btn {
            width:           38px !important;
            height:          38px !important;
            padding:         0 !important;
            margin:          0 !important;
            display:         flex !important;
            align-items:     center !important;
            justify-content: center !important;
            background:      rgba(12,12,16,0.72) !important;
            border:          1px solid rgba(255,255,255,0.13) !important;
            border-radius:   50% !important;
            backdrop-filter: blur(20px) saturate(180%) !important;
            -webkit-backdrop-filter: blur(20px) saturate(180%) !important;
            box-shadow:
                0 2px 16px rgba(0,0,0,0.55),
                0 1px 0 rgba(255,255,255,0.08) inset,
                0 -1px 0 rgba(0,0,0,0.30) inset !important;
            cursor:      pointer !important;
            outline:     none !important;
            user-select: none !important;
            transition:
                background   0.15s ease,
                transform    0.15s cubic-bezier(0.34,1.56,0.64,1),
                box-shadow   0.15s ease,
                border-color 0.15s ease !important;
        }
        .mw-btn:hover {
            background:   rgba(255,255,255,0.96) !important;
            border-color: rgba(255,255,255,0.6) !important;
            transform:    scale(1.14) !important;
            box-shadow:   0 6px 28px rgba(0,0,0,0.45), 0 1px 0 rgba(255,255,255,1) inset !important;
        }
        .mw-btn:hover svg { stroke: #0a0a0f !important; fill: #0a0a0f !important; }
        .mw-btn:active    { transform: scale(0.95) !important; transition-duration: 0.07s !important; }
        .mw-btn.s-loading { pointer-events:none !important; cursor:wait !important; background:rgba(14,14,18,0.88) !important; }
        .mw-btn.s-ok {
            pointer-events: none !important;
            background:   rgba(16,185,129,0.88) !important;
            border-color: rgba(110,231,183,0.35) !important;
            box-shadow:   0 4px 20px rgba(16,185,129,0.45), 0 1px 0 rgba(255,255,255,0.15) inset !important;
        }
        .mw-btn.s-err {
            background:   rgba(239,68,68,0.88) !important;
            border-color: rgba(252,165,165,0.3) !important;
            box-shadow:   0 4px 20px rgba(239,68,68,0.4), 0 1px 0 rgba(255,255,255,0.1) inset !important;
            cursor:       pointer !important;
        }
        @keyframes mw-spin { to { transform: rotate(360deg); } }
        .mw-spin {
            width: 16px !important; height: 16px !important;
            border: 1.5px solid rgba(255,255,255,0.1) !important;
            border-top-color: #fff !important;
            border-radius: 50% !important;
            animation: mw-spin 0.42s linear infinite !important;
            display: block !important;
        }

        /* ── Preview overlay ── */
        #mw-preview-wrap {
            position:        fixed !important;
            inset:           0 !important;
            z-index:         2147483647 !important;
            display:         flex !important;
            align-items:     center !important;
            justify-content: center !important;
            background:      rgba(0,0,0,0.82) !important;
            backdrop-filter: blur(14px) !important;
            -webkit-backdrop-filter: blur(14px) !important;
            animation:       mw-bg-in 0.18s ease !important;
            cursor:          pointer !important;
        }
        @keyframes mw-bg-in   { from{opacity:0}                        to{opacity:1} }
        @keyframes mw-card-in { from{opacity:0;transform:scale(0.84)}  to{opacity:1;transform:scale(1)} }
        @keyframes mw-bg-out  { from{opacity:1}                        to{opacity:0} }
        #mw-preview-card {
            position:      relative !important;
            max-width:     min(840px,92vw) !important;
            width:         100% !important;
            background:    rgba(8,8,12,0.98) !important;
            border:        1px solid rgba(255,255,255,0.09) !important;
            border-radius: 18px !important;
            overflow:      hidden !important;
            box-shadow:    0 40px 120px rgba(0,0,0,0.85) !important;
            animation:     mw-card-in 0.26s cubic-bezier(0.34,1.56,0.64,1) !important;
            cursor:        default !important;
        }
        #mw-preview-card video {
            width:      100% !important;
            display:    block !important;
            max-height: 74vh !important;
            object-fit: contain !important;
            background: #000 !important;
            cursor:     default !important;
        }

        /* ── Detail page tools bar ── */
        #mw-tools-bar {
            display:         flex !important;
            align-items:     center !important;
            gap:             10px !important;
            flex-wrap:       wrap !important;
            padding:         11px 15px !important;
            margin:          0 0 16px !important;
            background:      rgba(10,10,14,0.94) !important;
            border:          1px solid rgba(255,255,255,0.07) !important;
            border-radius:   12px !important;
            backdrop-filter: blur(20px) !important;
            -webkit-backdrop-filter: blur(20px) !important;
            box-shadow:      0 4px 24px rgba(0,0,0,0.45), 0 1px 0 rgba(255,255,255,0.05) inset !important;
            font-family:     'SF Pro Display','Segoe UI',system-ui,sans-serif !important;
        }
        #mw-tools-bar .mw-bar-lbl {
            font-size:10px !important; font-weight:700 !important; letter-spacing:0.9px !important;
            text-transform:uppercase !important; color:rgba(255,255,255,0.18) !important; white-space:nowrap !important;
        }
        .mw-bar-btn {
            display:inline-flex !important; align-items:center !important; gap:7px !important;
            padding:8px 16px !important; background:rgba(255,255,255,0.97) !important;
            color:#0a0a0f !important; border:none !important; border-radius:8px !important;
            font-size:12px !important; font-weight:700 !important;
            font-family:'SF Pro Display','Segoe UI',system-ui,sans-serif !important;
            cursor:pointer !important; outline:none !important;
            box-shadow:0 2px 12px rgba(0,0,0,0.3) !important;
            transition:background 0.13s,transform 0.12s !important; user-select:none !important;
        }
        .mw-bar-btn:hover    { background:#e8e8ec !important; transform:scale(1.03) !important; }
        .mw-bar-btn:active   { transform:scale(0.97) !important; }
        .mw-bar-btn:disabled { opacity:0.4 !important; cursor:wait !important; transform:none !important; }
        .mw-bar-status {
            font-size:11px !important; color:rgba(255,255,255,0.25) !important;
            font-family:'SF Pro Display','Segoe UI',system-ui,sans-serif !important; font-weight:500 !important;
        }
    `);

    // ══════════════════════════════════════════════════════
    //  INJECT BUTTONS INTO THUMBNAIL CARD
    // ══════════════════════════════════════════════════════
    const injected = new WeakSet();

    const EXCLUDED = new Set([
        'tag','category','page','author','search',
        'wp-content','wp-admin','wp-json','feed',
        'faq','contact','software','resolutions','sitemap',
    ]);

    const isDetailUrl = (href) => {
        try {
            const u     = new URL(normalizeUrl(href));
            if (!u.hostname.includes('moewalls.com')) return false;
            const parts = u.pathname.replace(/^\/|\/$/g, '').split('/').filter(Boolean);
            if (parts.length < 2) return false;
            return !parts.some(p => EXCLUDED.has(p));
        } catch { return false; }
    };

    const injectBtn = (article) => {
        if (injected.has(article)) return;

        const frame = article.querySelector('.g1-frame');
        if (!frame) return;

        const rawHref = frame.getAttribute('href') || frame.href || '';
        const pageUrl = normalizeUrl(rawHref);
        if (!pageUrl || !isDetailUrl(pageUrl)) return;

        injected.add(article);

        if (getComputedStyle(frame).position === 'static') frame.style.position = 'relative';

        // ── Button group ──
        const btns     = document.createElement('div');
        btns.className = 'mw-btns';
        btns.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); });

        // ── Preview button ──
        const prevBtn     = document.createElement('button');
        prevBtn.className = 'mw-btn';
        prevBtn.innerHTML = SVG.preview;
        prevBtn.title     = 'Preview live wallpaper';
        prevBtn.setAttribute('aria-label', 'Preview live wallpaper');

        let prevBusy = false;
        prevBtn.addEventListener('click', async (e) => {
            e.preventDefault(); e.stopPropagation(); e.stopImmediatePropagation();
            if (prevBusy) return;
            prevBusy = true;
            await masterPreview(pageUrl, (s) => applyState(prevBtn, s, SVG.preview));
            setTimeout(() => { prevBusy = false; }, 500);
        });

        // ── Download button ──
        const dlBtn     = document.createElement('button');
        dlBtn.className = 'mw-btn';
        dlBtn.innerHTML = SVG.dl;
        dlBtn.title     = 'Download wallpaper';
        dlBtn.setAttribute('aria-label', 'Download wallpaper');

        let dlBusy = false;
        dlBtn.addEventListener('click', async (e) => {
            e.preventDefault(); e.stopPropagation(); e.stopImmediatePropagation();
            if (dlBusy) return;
            dlBusy = true;
            await masterDownload(pageUrl, (s) => applyState(dlBtn, s, SVG.dl));
            setTimeout(() => { dlBusy = false; }, 2500);
        });

        btns.appendChild(prevBtn);
        btns.appendChild(dlBtn);
        frame.appendChild(btns);

        // ── Pre-warm cache on viewport entry ──
        if (!cGet(pageUrl)) {
            const io = new IntersectionObserver((entries, obs) => {
                if (!entries[0].isIntersecting) return;
                obs.disconnect();
                fetchPage(pageUrl)
                    .then(result => {
                        const data = extractPageData(result);
                        if (data.token || data.videoUrl) cSet(pageUrl, data);
                    })
                    .catch(() => {});
            }, { rootMargin: '200px' });
            io.observe(article);
        }
    };

    // ══════════════════════════════════════════════════════
    //  SCAN + MUTATION OBSERVER
    // ══════════════════════════════════════════════════════
    const scan = () => document.querySelectorAll('article.g1-collection-item, article').forEach(injectBtn);

    let scanDebounce;
    new MutationObserver((mutations) => {
        let relevant = false;
        for (const m of mutations) {
            for (const n of m.addedNodes) {
                if (n.nodeType !== 1) continue;
                if (n.tagName === 'ARTICLE' || n.querySelector?.('article')) { relevant = true; break; }
            }
            if (relevant) break;
        }
        if (relevant) { clearTimeout(scanDebounce); scanDebounce = setTimeout(scan, 160); }
    }).observe(document.body, { childList: true, subtree: true });

    // ══════════════════════════════════════════════════════
    //  DETAIL PAGE TOOLS BAR
    // ══════════════════════════════════════════════════════
    const enhanceDetailPage = () => {
        if (!isDetailUrl(location.href)) return;
        if (document.getElementById('mw-tools-bar')) return;

        let tries = 0;
        const poll = setInterval(() => {
            tries++;
            const realBtn = document.querySelector('#moe-download, a.lcc-wall[data-url], a[data-url][data-id]');
            if (!realBtn && tries < 40) return;
            clearInterval(poll);

            if (realBtn) {
                const token = realBtn.getAttribute('data-url');
                if (token && !cGet(location.href)) cSet(location.href, { token, videoUrl: null });
            }

            const bar    = document.createElement('div');   bar.id = 'mw-tools-bar';
            const lbl    = document.createElement('span');  lbl.className = 'mw-bar-lbl'; lbl.textContent = 'MoeWalls Tools';
            const dlBtn  = document.createElement('button'); dlBtn.className = 'mw-bar-btn'; dlBtn.innerHTML = `${SVG.dl}&nbsp; Download`;
            const prvBtn = document.createElement('button'); prvBtn.className = 'mw-bar-btn'; prvBtn.innerHTML = `${SVG.preview}&nbsp; Preview`;
            const status = document.createElement('span');  status.className = 'mw-bar-status';

            let dlBusy = false;
            dlBtn.addEventListener('click', async () => {
                if (dlBusy) return;
                dlBusy = dlBtn.disabled = true;
                await masterDownload(location.href, (s) => {
                    if      (s === 'loading') status.textContent = 'Starting…';
                    else if (s === 'ok')      { status.textContent = '✓ Downloading'; setTimeout(() => { status.textContent = ''; }, 3000); }
                    else                      { status.textContent = '✕ Failed — try again'; setTimeout(() => { status.textContent = ''; }, 3000); }
                });
                dlBtn.disabled = false; setTimeout(() => { dlBusy = false; }, 500);
            });

            let prvBusy = false;
            prvBtn.addEventListener('click', async () => {
                if (prvBusy) return;
                prvBusy = prvBtn.disabled = true;
                // On detail page: read src from live DOM first (no network needed)
                const liveEl = document.querySelector('.video-js source[src], video source[src], .vjs-tech[src], video[src]');
                if (liveEl) {
                    const s = liveEl.getAttribute('src');
                    showPreview(s.startsWith('http') ? s : 'https://moewalls.com' + s);
                } else {
                    status.textContent = 'Loading preview…';
                    await masterPreview(location.href, (s) => {
                        if (s === 'err') { status.textContent = '✕ Preview unavailable'; setTimeout(() => { status.textContent = ''; }, 3000); }
                        else status.textContent = '';
                    });
                }
                prvBtn.disabled = false; setTimeout(() => { prvBusy = false; }, 500);
            });

            bar.appendChild(lbl); bar.appendChild(dlBtn); bar.appendChild(prvBtn); bar.appendChild(status);
            if (realBtn) realBtn.parentNode.insertBefore(bar, realBtn);
            else { const fb = document.querySelector('.entry-header, article, main'); if (fb) fb.prepend(bar); }
        }, 150);
    };

    // ══════════════════════════════════════════════════════
    //  INIT
    // ══════════════════════════════════════════════════════
    const init = () => { scan(); enhanceDetailPage(); };
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
    else init();

    console.log('✅ [MoeWalls Preview & Download v9.2] Ready — Download + Preview');
})();
