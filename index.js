(function () {
    'use strict';

    const EXTENSION_NAME = 'tagmojis';
    const EXTENSION_TITLE = 'Tagmojis';
    const BRIDGE_KEY = '__tagmojisBridge';
    const EXTENSION_BASE = new URL('./', import.meta.url).href;
    const EMOJI_DATA_URL = `${EXTENSION_BASE}data/emoji-index.json`;
    const TWEMOJI_SCRIPT_URL = `${EXTENSION_BASE}lib/twemoji.min.js`;
    const SPRITE_SHEET_URL = `${EXTENSION_BASE}assets/twitter-sheet-32.png`;
    const DEFAULT_SETTINGS = {
        version: 1,
        tagMetaById: {},
    };
    const DISPLAY_SELECTORS = [
        '.tags .tag',
        '.tag_list .tag',
        '.rm_tag_controls .tag',
        '.tag',
        '.bogus_folder_select',
    ].join(', ');
    const DISPLAY_CONTAINER_SELECTORS = [
        '.tags',
        '.tag_list',
        '.rm_tag_controls',
        '.bogus_folder_select',
        '#tag_view_list',
    ].join(', ');
    const TAGMOJIS_OWNED_SELECTOR = [
        '[data-tagmojis-field]',
        '.tagmojis-prefix',
        '.tagmojis-prefix-space',
        '.tagmojis-preview-chip',
        '.tagmojis-panel',
    ].join(', ');
    const EMOJI_BATCH_SIZE = 80;
    let settings = structuredCloneSafe(DEFAULT_SETTINGS);
    const state = {
        initialized: false,
        emojiEntries: [],
        emojiByNative: new Map(),
        emojiByCodepoint: new Map(),
        tagById: new Map(),
        tagByName: new Map(),
        knownTagSignature: '',
        refreshQueued: false,
        fullRefreshRequested: false,
        pendingRefreshRoots: new Set(),
        observer: null,
        persistTimer: null,
        activePanel: null,
        activeField: null,
        twemojiReady: false,
    };

    function structuredCloneSafe(value) {
        if (typeof globalThis.structuredClone === 'function') {
            return globalThis.structuredClone(value);
        }
        return JSON.parse(JSON.stringify(value));
    }

    function log(...args) {
        console.debug(`[${EXTENSION_NAME}]`, ...args);
    }

    function getContextSafe() {
        try {
            return globalThis.SillyTavern?.getContext?.() ?? globalThis.getContext?.() ?? null;
        } catch (error) {
            console.warn(`[${EXTENSION_NAME}] Failed to get context`, error);
            return null;
        }
    }

    function getExtensionSettingsRoot(context) {
        return context?.extensionSettings ?? context?.extension_settings ?? globalThis.extension_settings ?? null;
    }

    function ensureSettings(context = getContextSafe()) {
        const root = getExtensionSettingsRoot(context);
        if (root) {
            root[EXTENSION_NAME] ??= structuredCloneSafe(DEFAULT_SETTINGS);
            settings = Object.assign(structuredCloneSafe(DEFAULT_SETTINGS), root[EXTENSION_NAME]);
        } else {
            settings = Object.assign(structuredCloneSafe(DEFAULT_SETTINGS), settings);
        }
        return settings;
    }

    async function persistSettings(context = getContextSafe()) {
        const root = getExtensionSettingsRoot(context);
        if (root) {
            root[EXTENSION_NAME] = settings;
        }

        const saver = context?.saveSettingsDebounced
            ?? context?.saveSettings
            ?? globalThis.saveSettingsDebounced
            ?? globalThis.saveSettings;

        if (typeof saver === 'function') {
            await saver();
        }
    }

    function schedulePersist() {
        window.clearTimeout(state.persistTimer);
        state.persistTimer = window.setTimeout(() => {
            persistSettings().catch((error) => console.warn(`[${EXTENSION_NAME}] Failed to persist settings`, error));
        }, 120);
    }

    function normalizeString(value) {
        return typeof value === 'string' ? value.trim() : '';
    }

    function normalizeLookup(value) {
        return normalizeString(value).toLowerCase();
    }

    function escapeHtml(value) {
        return String(value ?? '')
            .replaceAll('&', '&amp;')
            .replaceAll('<', '&lt;')
            .replaceAll('>', '&gt;')
            .replaceAll('"', '&quot;')
            .replaceAll("'", '&#39;');
    }

    function getTagsList(context = getContextSafe()) {
        return Array.isArray(context?.tags)
            ? context.tags
            : Array.isArray(context?.tagList)
                ? context.tagList
                : Array.isArray(globalThis.tags)
                    ? globalThis.tags
                    : [];
    }

    function refreshTagCaches(context = getContextSafe()) {
        const tags = getTagsList(context);
        const nextById = new Map();
        const nextByName = new Map();

        for (const tag of tags) {
            if (!tag?.id) {
                continue;
            }

            const id = String(tag.id);
            nextById.set(id, tag);
            nextByName.set(normalizeLookup(tag.name), tag);
        }

        state.tagById = nextById;
        state.tagByName = nextByName;

        const signature = tags
            .map((tag) => `${tag?.id ?? ''}:${normalizeString(tag?.name)}:${tag?.create_date ?? ''}`)
            .join('|');

        if (signature !== state.knownTagSignature) {
            state.knownTagSignature = signature;
            sanitizeMetadata();
        }

        return tags;
    }

    function sanitizeMetadata() {
        const nextMeta = {};

        for (const [tagId, meta] of Object.entries(settings.tagMetaById ?? {})) {
            if (!state.tagById.has(String(tagId))) {
                continue;
            }

            const emoji = normalizeString(meta?.emoji);
            if (!emoji) {
                continue;
            }

            nextMeta[String(tagId)] = {
                emoji,
                position: 'prefix',
            };
        }

        settings.tagMetaById = nextMeta;
    }

    async function loadTwemoji() {
        if (globalThis.twemoji) {
            state.twemojiReady = true;
            return globalThis.twemoji;
        }

        await new Promise((resolve, reject) => {
            const existing = document.querySelector(`script[data-${EXTENSION_NAME}-twemoji="true"]`);
            if (existing) {
                existing.addEventListener('load', resolve, { once: true });
                existing.addEventListener('error', reject, { once: true });
                return;
            }

            const script = document.createElement('script');
            script.src = TWEMOJI_SCRIPT_URL;
            script.async = true;
            script.dataset[`${EXTENSION_NAME}Twemoji`] = 'true';
            script.addEventListener('load', resolve, { once: true });
            script.addEventListener('error', reject, { once: true });
            document.head.appendChild(script);
        });

        state.twemojiReady = Boolean(globalThis.twemoji);
        return globalThis.twemoji;
    }

    async function loadEmojiIndex() {
        const response = await fetch(EMOJI_DATA_URL, { cache: 'no-cache' });
        if (!response.ok) {
            throw new Error(`Failed to load emoji data: ${response.status}`);
        }

        const payload = await response.json();
        const entries = Array.isArray(payload?.entries) ? payload.entries : [];

        state.emojiEntries = entries;
        state.emojiByNative = new Map(entries.map((entry) => [entry.n, entry]));
        state.emojiByCodepoint = new Map(entries.map((entry) => [String(entry.u).toLowerCase(), entry]));

        document.documentElement.style.setProperty('--tagmojis-sheet-cols', String(payload?.sprite?.cols ?? 1));
        document.documentElement.style.setProperty('--tagmojis-sheet-rows', String(payload?.sprite?.rows ?? 1));
        document.documentElement.style.setProperty('--tagmojis-sheet-url', `url("${SPRITE_SHEET_URL}")`);
    }

    function toCodePoint(value) {
        if (!value) {
            return '';
        }

        try {
            if (globalThis.twemoji?.convert?.toCodePoint) {
                return globalThis.twemoji.convert.toCodePoint(value).toLowerCase();
            }
        } catch (error) {
            console.warn(`[${EXTENSION_NAME}] Failed to use Twemoji codepoint conversion`, error);
        }

        const points = [];
        for (const symbol of Array.from(value)) {
            const point = symbol.codePointAt(0);
            if (point != null) {
                points.push(point.toString(16));
            }
        }
        return points.join('-').toLowerCase();
    }

    function getEmojiEntry(emoji) {
        const normalized = normalizeString(emoji);
        if (!normalized) {
            return null;
        }
        return state.emojiByNative.get(normalized) ?? state.emojiByCodepoint.get(toCodePoint(normalized)) ?? null;
    }

    function getTagMeta(tagId) {
        return settings.tagMetaById?.[String(tagId)] ?? null;
    }

    function getBridgeApi() {
        return {
            extensionName: EXTENSION_NAME,
            isActive() {
                return state.initialized;
            },
            getEmojiForTag(tagId) {
                const normalizedId = normalizeString(tagId);
                if (!normalizedId || !state.initialized) {
                    return '';
                }

                ensureSettings();
                refreshTagCaches();
                return normalizeString(getTagMeta(normalizedId)?.emoji);
            },
        };
    }

    function updateTagMeta(tagId, emoji) {
        const id = String(tagId ?? '');
        if (!id) {
            return;
        }

        const normalizedEmoji = normalizeString(emoji);
        if (!normalizedEmoji) {
            delete settings.tagMetaById[id];
        } else {
            settings.tagMetaById[id] = {
                emoji: normalizedEmoji,
                position: 'prefix',
            };
        }

        schedulePersist();
        queueRefresh();
    }

    function renderEmojiSprite(entry, fallbackEmoji, className) {
        if (entry) {
            return `
                <span
                    class="${className}"
                    aria-hidden="true"
                    style="--tagmojis-x:${Number(entry.x) || 0}; --tagmojis-y:${Number(entry.y) || 0};"
                ></span>
            `;
        }

        return `<span class="${className} ${className}--native">${escapeHtml(fallbackEmoji)}</span>`;
    }

    function renderPreviewChip(emoji, tagName, extraClass = '') {
        const normalizedEmoji = normalizeString(emoji);
        if (!normalizedEmoji) {
            return '';
        }

        const entry = getEmojiEntry(normalizedEmoji);
        return `
            <span class="tagmojis-preview-chip ${extraClass}">
                ${renderEmojiSprite(entry, normalizedEmoji, 'tagmojis-preview-emoji')}
                <span>${escapeHtml(tagName)}</span>
            </span>
        `;
    }

    function isTagmojisOwnedNode(node) {
        return node instanceof HTMLElement && (
            node.matches(TAGMOJIS_OWNED_SELECTOR) ||
            Boolean(node.closest(TAGMOJIS_OWNED_SELECTOR))
        );
    }

    function getEmojiCategories() {
        return [...new Set(
            state.emojiEntries
                .map((entry) => normalizeString(entry.c))
                .filter(Boolean)
                .filter((category) => category !== 'Component')
        )].sort((left, right) => left.localeCompare(right));
    }

    function matchesEmojiSearch(entry, normalizedQuery) {
        if (!normalizedQuery) {
            return true;
        }

        const aliases = Array.isArray(entry.a) ? entry.a : [];
        const haystacks = [
            String(entry.s ?? '').replaceAll('_', ' ').toLowerCase(),
            ...aliases.map((alias) => String(alias).replaceAll('_', ' ').toLowerCase()),
        ];

        return haystacks.some((value) => value.includes(normalizedQuery));
    }

    function buildEmojiResults(query, category = 'all') {
        const normalizedQuery = normalizeLookup(query);
        if (!state.emojiEntries.length) {
            return [];
        }

        return state.emojiEntries
            .filter((entry) => category === 'all' || normalizeString(entry.c) === category)
            .filter((entry) => matchesEmojiSearch(entry, normalizedQuery))
            .sort((left, right) => {
                const leftName = String(left.s ?? '').replaceAll('_', ' ');
                const rightName = String(right.s ?? '').replaceAll('_', ' ');
                const byName = leftName.localeCompare(rightName);
                if (byName !== 0) {
                    return byName;
                }
                return String(left.u ?? '').localeCompare(String(right.u ?? ''));
            });
    }

    function renderCategoryFilters(selectedCategory = 'all') {
        const buttons = [
            `<button type="button" class="tagmojis-category${selectedCategory === 'all' ? ' is-selected' : ''}" data-action="pick-emoji-category" data-category="all">All</button>`,
            ...getEmojiCategories().map((category) => `
                <button
                    type="button"
                    class="tagmojis-category${selectedCategory === category ? ' is-selected' : ''}"
                    data-action="pick-emoji-category"
                    data-category="${escapeHtml(category)}"
                >${escapeHtml(category)}</button>
            `),
        ];

        return buttons.join('');
    }

    function renderEmojiResult(entry) {
        return `
            <button
                type="button"
                class="tagmojis-result"
                data-action="pick-emoji"
                data-emoji="${escapeHtml(entry.n)}"
            >
                ${renderEmojiSprite(entry, entry.n, 'tagmojis-result-emoji')}
                <span class="tagmojis-result-name">
                    <span class="tagmojis-result-title">${escapeHtml(entry.s.replaceAll('_', ' '))}</span>
                    <span class="tagmojis-result-meta">${escapeHtml(entry.c)}</span>
                </span>
            </button>
        `;
    }

    function renderResultsStatus(visibleCount, totalCount) {
        if (!totalCount) {
            return '';
        }

        return `Showing ${visibleCount.toLocaleString()} of ${totalCount.toLocaleString()}`;
    }

    function renderPanelActions(hasEmoji) {
        return `
            <div class="tagmojis-panel-actions">
                <button type="button" class="tagmojis-panel-remove${hasEmoji ? '' : ' is-disabled'}" data-action="clear-emoji"${hasEmoji ? '' : ' disabled'}>
                    Remove Emoji
                </button>
            </div>
        `;
    }

    function renderPickerField({ emoji = '', tagName = 'Tag preview', mode = 'edit' } = {}) {
        const normalizedEmoji = normalizeString(emoji);
        const initialResults = buildEmojiResults('', 'all');
        const initialVisibleCount = Math.min(EMOJI_BATCH_SIZE, initialResults.length);
        const previewChip = renderPreviewChip(
            normalizedEmoji,
            tagName,
            mode === 'edit' ? 'tagmojis-manager-chip' : ''
        );

        return `
            <div class="tagmojis-field" data-tagmojis-field data-tagmojis-mode="${escapeHtml(mode)}">
                <span class="tagmojis-label">Emoji</span>
                <div class="tagmojis-control-row">
                    <button type="button" class="tagmojis-trigger" data-action="toggle-emoji-panel">
                        ${normalizedEmoji
                            ? `${renderEmojiSprite(getEmojiEntry(normalizedEmoji), normalizedEmoji, 'tagmojis-preview-emoji')}<span class="tagmojis-trigger-label">${escapeHtml(normalizedEmoji)} selected</span>`
                            : '<span class="tagmojis-trigger-label">Choose an emoji</span>'}
                    </button>
                    <button type="button" class="tagmojis-clear" data-action="clear-emoji">Clear</button>
                </div>
                <input type="hidden" data-role="emoji-value" value="${escapeHtml(normalizedEmoji)}">
                ${previewChip}
                <div class="tagmojis-panel" data-role="emoji-panel">
                    <input type="search" class="tagmojis-search" data-role="emoji-search" placeholder="Search emojis">
                    ${renderPanelActions(Boolean(normalizedEmoji))}
                    <div class="tagmojis-categories" data-role="emoji-categories">
                        ${renderCategoryFilters('all')}
                    </div>
                    <div class="tagmojis-results" data-role="emoji-results">
                        ${initialResults.slice(0, EMOJI_BATCH_SIZE).map(renderEmojiResult).join('')}
                    </div>
                    <div class="tagmojis-status" data-role="emoji-status">${renderResultsStatus(initialVisibleCount, initialResults.length)}</div>
                    <div class="tagmojis-empty" data-role="emoji-empty" hidden>No emoji matches that search.</div>
                </div>
            </div>
        `;
    }

    function getCandidateTagNameForElement(element) {
        if (!(element instanceof HTMLElement)) {
            return '';
        }

        const explicit = normalizeString(element.dataset.tagName);
        if (explicit) {
            return explicit;
        }

        const clone = element.cloneNode(true);
        for (const decorator of clone.querySelectorAll('.tagmojis-prefix, .tagmojis-prefix-space, .tagmojis-field, .tagmojis-manager-chip')) {
            decorator.remove();
        }

        const text = normalizeString(clone.textContent);
        if (text && state.tagByName.has(normalizeLookup(text))) {
            return text;
        }

        const compact = normalizeString(text.replace(/\s+/g, ' '));
        if (compact && state.tagByName.has(normalizeLookup(compact))) {
            return compact;
        }

        return '';
    }

    function decorateTagElement(element) {
        if (!(element instanceof HTMLElement)) {
            return;
        }

        if (element.closest('#tag_view_list') && element.classList.contains('tag_view_name')) {
            return;
        }

        if (element.closest('[data-tagmojis-field]')) {
            return;
        }

        if (element.matches('.tagmojis-result, .tagmojis-trigger, .tagmojis-clear')) {
            return;
        }

        const tagName = getCandidateTagNameForElement(element);
        if (!tagName) {
            return;
        }

        const tag = state.tagByName.get(normalizeLookup(tagName));
        if (!tag?.id) {
            return;
        }

        const meta = getTagMeta(tag.id);
        const existingPrefix = element.querySelector(':scope > .tagmojis-prefix');
        const existingSpacer = element.querySelector(':scope > .tagmojis-prefix-space');
        const emoji = normalizeString(meta?.emoji);
        const decorationKey = `${tag.id}:${emoji}`;

        if (!emoji) {
            existingPrefix?.remove();
            existingSpacer?.remove();
            delete element.dataset.tagmojisDecorated;
            return;
        }

        if (element.dataset.tagmojisDecorated === decorationKey && existingPrefix) {
            return;
        }

        const entry = getEmojiEntry(emoji);
        const prefixMarkup = renderEmojiSprite(entry, emoji, 'tagmojis-prefix');
        let prefixElement = existingPrefix;
        element.dataset.tagmojisDecorated = decorationKey;

        if (!prefixElement) {
            const template = document.createElement('template');
            template.innerHTML = prefixMarkup.trim();
            prefixElement = template.content.firstElementChild;
            if (!prefixElement) {
                return;
            }

            const spacer = document.createElement('span');
            spacer.className = 'tagmojis-prefix-space';
            spacer.setAttribute('aria-hidden', 'true');
            element.prepend(spacer);
            element.prepend(prefixElement);
            return;
        }

        prefixElement.outerHTML = prefixMarkup.trim();
        if (!existingSpacer) {
            const spacer = document.createElement('span');
            spacer.className = 'tagmojis-prefix-space';
            spacer.setAttribute('aria-hidden', 'true');
            element.insertBefore(spacer, element.querySelector(':scope > .tagmojis-prefix')?.nextSibling ?? null);
        }
    }

    function decorateTags(root = document) {
        if (!(root instanceof Document || root instanceof HTMLElement || root instanceof DocumentFragment)) {
            return;
        }

        const candidates = root instanceof HTMLElement && root.matches(DISPLAY_SELECTORS)
            ? [root, ...root.querySelectorAll(DISPLAY_SELECTORS)]
            : [...root.querySelectorAll(DISPLAY_SELECTORS)];

        for (const candidate of candidates) {
            decorateTagElement(candidate);
        }
    }

    function queueRefresh(root = document) {
        if (root instanceof HTMLElement && root.isConnected && !isTagmojisOwnedNode(root)) {
            state.pendingRefreshRoots.add(root);
        } else if (root instanceof Document || root === document) {
            state.fullRefreshRequested = true;
        } else if (!root) {
            state.fullRefreshRequested = true;
        }

        if (state.refreshQueued) {
            return;
        }

        state.refreshQueued = true;
        window.requestAnimationFrame(() => {
            state.refreshQueued = false;
            refreshTagCaches();

            const shouldFullRefresh = state.fullRefreshRequested || !state.pendingRefreshRoots.size;
            const roots = shouldFullRefresh ? [document] : [...state.pendingRefreshRoots];
            state.fullRefreshRequested = false;
            state.pendingRefreshRoots.clear();

            for (const refreshRoot of roots) {
                if (refreshRoot instanceof HTMLElement && !refreshRoot.isConnected) {
                    continue;
                }

                injectManagerFields(refreshRoot instanceof Document ? document : refreshRoot);
                decorateTags(refreshRoot instanceof Document ? document : refreshRoot);
            }
        });
    }

    function getRefreshRootForNode(node) {
        if (!(node instanceof HTMLElement) || !node.isConnected || isTagmojisOwnedNode(node)) {
            return null;
        }

        const manager = node.closest('#tag_view_list');
        if (manager instanceof HTMLElement) {
            return manager;
        }

        if (node.matches(DISPLAY_SELECTORS) || node.matches(DISPLAY_CONTAINER_SELECTORS)) {
            return node;
        }

        const displayContainer = node.closest(DISPLAY_CONTAINER_SELECTORS);
        if (displayContainer instanceof HTMLElement) {
            return displayContainer;
        }

        if (node.querySelector(DISPLAY_SELECTORS) || node.querySelector('.tag_view_item')) {
            return node;
        }

        return null;
    }

    function collectMutationRefreshRoots(records) {
        const roots = new Set();

        for (const record of records) {
            const targetRoot = getRefreshRootForNode(record.target);
            if (targetRoot) {
                roots.add(targetRoot);
            }

            for (const node of record.addedNodes) {
                if (!(node instanceof HTMLElement)) {
                    continue;
                }

                const root = getRefreshRootForNode(node);
                if (root) {
                    roots.add(root);
                }
            }
        }

        return roots;
    }

    function matchTagForManagerRow(row) {
        if (!(row instanceof HTMLElement)) {
            return null;
        }

        const tagId = normalizeString(row.id || row.dataset.tagmojisTagId);
        if (tagId && state.tagById.has(tagId)) {
            return state.tagById.get(tagId);
        }

        return null;
    }

    function syncFieldPreview(field, tagName) {
        const hiddenInput = field.querySelector('[data-role="emoji-value"]');
        const emoji = normalizeString(hiddenInput?.value);
        const trigger = field.querySelector('.tagmojis-trigger');
        const existingChip = field.querySelector('.tagmojis-preview-chip');
        const removeButton = field.querySelector('.tagmojis-panel-remove');

        if (trigger) {
            trigger.innerHTML = emoji
                ? `${renderEmojiSprite(getEmojiEntry(emoji), emoji, 'tagmojis-preview-emoji')}<span class="tagmojis-trigger-label">${escapeHtml(emoji)} selected</span>`
                : '<span class="tagmojis-trigger-label">Choose an emoji</span>';
        }

        if (removeButton instanceof HTMLButtonElement) {
            removeButton.disabled = !emoji;
            removeButton.classList.toggle('is-disabled', !emoji);
        }

        const previewMarkup = renderPreviewChip(
            emoji,
            tagName,
            field.dataset.tagmojisMode === 'edit' ? 'tagmojis-manager-chip' : ''
        );
        if (existingChip) {
            existingChip.remove();
        }
        if (previewMarkup) {
            const template = document.createElement('template');
            template.innerHTML = previewMarkup.trim();
            field.append(template.content.firstElementChild);
        }
    }

    function getFieldResultState(field) {
        const query = normalizeString(field.querySelector('[data-role="emoji-search"]')?.value ?? '');
        const category = normalizeString(field.dataset.tagmojisCategory) || 'all';
        const limit = Math.max(EMOJI_BATCH_SIZE, Number(field.dataset.tagmojisLimit) || EMOJI_BATCH_SIZE);
        const matches = buildEmojiResults(query, category);
        return { query, category, limit, matches };
    }

    function renderResultsForField(field, { preserveScroll = false } = {}) {
        const results = field.querySelector('[data-role="emoji-results"]');
        const empty = field.querySelector('[data-role="emoji-empty"]');
        const categories = field.querySelector('[data-role="emoji-categories"]');
        const status = field.querySelector('[data-role="emoji-status"]');
        if (!(results instanceof HTMLElement) || !(empty instanceof HTMLElement)) {
            return;
        }

        const previousScrollTop = preserveScroll ? results.scrollTop : 0;
        const { category, limit, matches } = getFieldResultState(field);
        const visibleMatches = matches.slice(0, limit);

        field.dataset.tagmojisLimit = String(limit);

        if (categories instanceof HTMLElement) {
            categories.innerHTML = renderCategoryFilters(category);
        }

        results.innerHTML = visibleMatches.map(renderEmojiResult).join('');
        empty.hidden = matches.length > 0;

        if (status instanceof HTMLElement) {
            status.textContent = renderResultsStatus(visibleMatches.length, matches.length);
        }

        if (preserveScroll) {
            results.scrollTop = previousScrollTop;
        } else {
            results.scrollTop = 0;
        }
    }

    function maybeLoadMoreResults(field) {
        const results = field.querySelector('[data-role="emoji-results"]');
        if (!(results instanceof HTMLElement)) {
            return;
        }

        const { limit, matches } = getFieldResultState(field);
        if (limit >= matches.length) {
            return;
        }

        const threshold = 120;
        const distanceFromBottom = results.scrollHeight - results.scrollTop - results.clientHeight;
        if (distanceFromBottom > threshold) {
            return;
        }

        field.dataset.tagmojisLimit = String(Math.min(matches.length, limit + EMOJI_BATCH_SIZE));
        renderResultsForField(field, { preserveScroll: true });
    }

    function refreshSearchResults(field, query) {
        const input = field.querySelector('[data-role="emoji-search"]');
        if (input instanceof HTMLInputElement && input.value !== query) {
            input.value = query;
        }
        field.dataset.tagmojisLimit = String(EMOJI_BATCH_SIZE);
        renderResultsForField(field);
    }

    function positionPanel(field) {
        const panel = field.querySelector('[data-role="emoji-panel"]');
        if (!(panel instanceof HTMLElement)) {
            return;
        }

        const viewportWidth = window.innerWidth;
        const viewportHeight = window.innerHeight;
        const panelWidth = Math.min(520, Math.max(420, viewportWidth - 48));
        const panelHeight = Math.min(620, Math.max(420, viewportHeight - 120));
        const left = Math.max(12, Math.round((viewportWidth - panelWidth) / 2));
        const top = Math.max(12, Math.round((viewportHeight - panelHeight) / 2));

        panel.style.width = `${panelWidth}px`;
        panel.style.maxHeight = `${panelHeight}px`;
        panel.style.maxWidth = `calc(100vw - 24px)`;
        panel.style.left = `${Math.round(left)}px`;
        panel.style.top = `${Math.round(top)}px`;
    }

    function positionActivePanel() {
        if (state.activeField instanceof HTMLElement) {
            positionPanel(state.activeField);
        }
    }

    function injectManagerFields(root = document) {
        const dialog = root instanceof HTMLElement && root.matches('#tag_view_list')
            ? root
            : root.querySelector('#tag_view_list');
        if (!(dialog instanceof HTMLElement)) {
            return;
        }

        const rows = dialog.querySelectorAll('.tag_view_item');
        for (const row of rows) {
            const tag = matchTagForManagerRow(row);
            if (!tag?.id) {
                continue;
            }

            row.dataset.tagmojisTagId = String(tag.id);
            const field = row.querySelector('[data-tagmojis-field]');
            if (!field) {
                const template = document.createElement('template');
                template.innerHTML = renderPickerField({
                    emoji: getTagMeta(tag.id)?.emoji ?? '',
                    tagName: normalizeString(tag.name) || 'Tag preview',
                    mode: 'edit',
                }).trim();
                const nextField = template.content.firstElementChild;
                const nameElement = row.querySelector('.tag_view_name');
                const counterElement = row.querySelector('.tag_view_counter');
                const deleteElement = row.querySelector('.tag_delete');
                if (nameElement?.parentNode && nextField) {
                    nameElement.insertAdjacentElement('beforebegin', nextField);
                } else if (counterElement?.parentNode && nextField) {
                    counterElement.insertAdjacentElement('beforebegin', nextField);
                } else if (deleteElement?.parentNode && nextField) {
                    deleteElement.insertAdjacentElement('beforebegin', nextField);
                }
            } else {
                field.dataset.tagmojisMode = 'edit';
                const hiddenInput = field.querySelector('[data-role="emoji-value"]');
                if (hiddenInput instanceof HTMLInputElement) {
                    hiddenInput.value = getTagMeta(tag.id)?.emoji ?? '';
                }
                syncFieldPreview(field, normalizeString(tag.name) || 'Tag preview');
            }
        }
    }

    function closeActivePanel() {
        if (state.activePanel instanceof HTMLElement) {
            state.activePanel.classList.remove('is-open');
            state.activePanel.style.left = '';
            state.activePanel.style.top = '';
            state.activePanel.style.width = '';
            state.activePanel.style.visibility = '';
        }
        state.activePanel = null;
        state.activeField = null;
    }

    function openPanel(field) {
        closeActivePanel();
        const panel = field.querySelector('[data-role="emoji-panel"]');
        const input = field.querySelector('[data-role="emoji-search"]');
        if (!(panel instanceof HTMLElement)) {
            return;
        }
        panel.classList.add('is-open');
        state.activePanel = panel;
        state.activeField = field;
        field.dataset.tagmojisCategory = field.dataset.tagmojisCategory || 'all';
        field.dataset.tagmojisLimit = String(EMOJI_BATCH_SIZE);
        if (input instanceof HTMLInputElement) {
            input.value = '';
            refreshSearchResults(field, '');
            window.setTimeout(() => {
                positionPanel(field);
                input.focus();
            }, 0);
        } else {
            window.setTimeout(() => positionPanel(field), 0);
        }
    }

    function handleDocumentClick(event) {
        const target = event.target;
        if (!(target instanceof HTMLElement)) {
            return;
        }

        const actionElement = target.closest('[data-action]');
        const action = actionElement?.getAttribute('data-action');
        const field = target.closest('[data-tagmojis-field]');

        if (!field && state.activePanel && !target.closest('[data-role="emoji-panel"]')) {
            closeActivePanel();
        }

        if (!action || !(field instanceof HTMLElement)) {
            return;
        }

        switch (action) {
            case 'toggle-emoji-panel':
                event.preventDefault();
                if (field.querySelector('[data-role="emoji-panel"]') === state.activePanel) {
                    closeActivePanel();
                } else {
                    openPanel(field);
                }
                break;
            case 'clear-emoji':
                event.preventDefault();
                applyFieldEmoji(field, '');
                closeActivePanel();
                break;
            case 'pick-emoji': {
                event.preventDefault();
                const emoji = actionElement?.getAttribute('data-emoji') ?? '';
                applyFieldEmoji(field, emoji);
                closeActivePanel();
                break;
            }
            case 'pick-emoji-category':
                event.preventDefault();
                field.dataset.tagmojisCategory = actionElement?.getAttribute('data-category') ?? 'all';
                field.dataset.tagmojisLimit = String(EMOJI_BATCH_SIZE);
                refreshSearchResults(field, field.querySelector('[data-role="emoji-search"]')?.value ?? '');
                positionPanel(field);
                break;
            default:
                break;
        }
    }

    function applyFieldEmoji(field, emoji) {
        const hiddenInput = field.querySelector('[data-role="emoji-value"]');
        if (!(hiddenInput instanceof HTMLInputElement)) {
            return;
        }

        const normalizedEmoji = normalizeString(emoji);
        hiddenInput.value = normalizedEmoji;

        const row = field.closest('.tag_view_item');
        const tagId = normalizeString(row?.dataset.tagmojisTagId);
        const tagName = normalizeString(state.tagById.get(tagId)?.name ?? '');

        syncFieldPreview(field, tagName || 'Tag preview');

        if (tagId) {
            updateTagMeta(tagId, normalizedEmoji);
        }
    }

    function handleInput(event) {
        const target = event.target;
        if (!(target instanceof HTMLElement)) {
            return;
        }

        if (target.matches('[data-role="emoji-search"]')) {
            const field = target.closest('[data-tagmojis-field]');
            if (field instanceof HTMLElement) {
                refreshSearchResults(field, target.value);
                positionPanel(field);
            }
            return;
        }
    }

    function handleScroll(event) {
        const target = event.target;
        if (!(target instanceof HTMLElement)) {
            return;
        }

        if (target.matches('[data-role="emoji-results"]')) {
            const field = target.closest('[data-tagmojis-field]');
            if (field instanceof HTMLElement) {
                maybeLoadMoreResults(field);
            }
        }
    }

    function handleDialogActions(event) {
        const target = event.target;
        if (!(target instanceof HTMLElement)) {
            return;
        }

        const dialog = target.closest('#tag_view_list');
        if (!(dialog instanceof HTMLElement)) {
            return;
        }

        const row = target.closest('.tag_view_item');
        if (!row) {
            return;
        }

        if (target.closest('.tag_delete')) {
            const tagId = normalizeString(row.dataset.tagmojisTagId);
            if (tagId) {
                delete settings.tagMetaById[tagId];
                schedulePersist();
            }
        }
    }

    function observeDom() {
        state.observer?.disconnect();
        state.observer = new MutationObserver((records) => {
            const roots = collectMutationRefreshRoots(records);
            if (!roots.size) {
                return;
            }

            for (const root of roots) {
                queueRefresh(root);
            }
        });
        state.observer.observe(document.body, {
            childList: true,
            subtree: true,
        });
    }

    async function initialize() {
        if (state.initialized) {
            return;
        }

        ensureSettings();
        refreshTagCaches();

        const assetResults = await Promise.allSettled([
            loadTwemoji(),
            loadEmojiIndex(),
        ]);

        for (const result of assetResults) {
            if (result.status === 'rejected') {
                console.warn(`[${EXTENSION_NAME}] Optional asset failed to load`, result.reason);
            }
        }

        document.addEventListener('click', handleDocumentClick, true);
        document.addEventListener('click', handleDialogActions, true);
        document.addEventListener('input', handleInput, true);
        document.addEventListener('scroll', handleScroll, true);
        window.addEventListener('resize', positionActivePanel);
        window.addEventListener('scroll', positionActivePanel, true);
        observeDom();
        queueRefresh();

        state.initialized = true;
        globalThis[BRIDGE_KEY] = getBridgeApi();
        log(`${EXTENSION_TITLE} initialized`);
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', () => {
            initialize().catch((error) => console.error(`[${EXTENSION_NAME}] Failed to initialize`, error));
        }, { once: true });
    } else {
        initialize().catch((error) => console.error(`[${EXTENSION_NAME}] Failed to initialize`, error));
    }
})();
