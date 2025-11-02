// 🎭 Perfect Mimic Subtitle System Core
// Main system class and initialization

// Make class globally available
window.PerfectMimicSubtitleSystem = class PerfectMimicSubtitleSystem {
  constructor() {
    // Storage manager instance (will be set in init)
    this.storage = null;

    // Word lists (Sets for fast lookup)
    this.knownWords = new Set();
    this.unknownWords = new Set();

    // Settings
    this.isActive = true;
    this.pauseOnHover = true;
    this.knownColor = '#10b981';
    this.learningColor = '#f59e0b';

    // Native YouTube elements
    this.nativeContainer = null;
    this.nativeLines = [];

    // Our mimic elements
    this.mimicContainer = null;
    this.mimicLines = [];

    // State tracking
    this.domState = {
      lineCount: 0,
      lineTexts: [],
      lineStyles: [],
      lastUpdate: 0
    };

    // Observers
    this.structureObserver = null; // Watch line add/remove
    this.textObserver = null; // Watch text changes
    this.attributeObserver = null; // Watch style changes

    // Performance
    this.updateQueue = [];
    this.isProcessing = false;

    // Menu management
    this.currentMenu = null;
    this.currentMenuClickHandler = null;
    this.menuTimeouts = [];
    
    // Event listener tracking to prevent leaks
    // Map<Element, Array<{ event: string, handler: Function }>>
    this._trackedListeners = new Map();
  }

  /**
   * Validate class names to prevent XSS
   */
  validateClassName(className) {
    // Whitelist approach
    const validClasses = [
      'mimic-word',
      'known-word',
      'learning-word',
      'unknown-word',
      'unmarked-word',
      'mimic-subtitle-text'
    ];
    
    if (!validClasses.includes(className)) {
      console.warn(`Invalid class name rejected: ${className}`);
      return false;
    }
    
    return true;
  }

  /**
   * Initialize accessibility features
   */
  initAccessibility() {
    // Add hidden status descriptions for screen readers
    const statusKnown = document.createElement('div');
    statusKnown.id = 'word-status-known';
    statusKnown.className = 'sr-only';
    statusKnown.textContent = 'This word is marked as known';

    const statusLearning = document.createElement('div');
    statusLearning.id = 'word-status-learning';
    statusLearning.className = 'sr-only';
    statusLearning.textContent = 'You are currently learning this word';

    const statusUnmarked = document.createElement('div');
    statusUnmarked.id = 'word-status-unmarked';
    statusUnmarked.className = 'sr-only';
    statusUnmarked.textContent = 'This word is not marked';

    document.body.append(statusKnown, statusLearning, statusUnmarked);

    // Initialize keyboard navigation
    this.initKeyboardNavigation();
  }

  /**
   * Initialize keyboard navigation for subtitle words
   */
  initKeyboardNavigation() {
    this._currentFocusIndex = -1;
    this._wordElements = [];

    // Update word list when subtitles change
    this.updateWordList();

    // Attach keyboard listeners
    document.addEventListener('keydown', (e) => {
      // Only handle if subtitle system is active and visible
      if (!this.isActive || !this.mimicContainer) return;

      switch(e.key) {
        case 'Tab':
          e.preventDefault();
          if (e.shiftKey) {
            this.focusPreviousWord();
          } else {
            this.focusNextWord();
          }
          break;

        case 'ArrowRight':
          e.preventDefault();
          this.focusNextWord();
          break;

        case 'ArrowLeft':
          e.preventDefault();
          this.focusPreviousWord();
          break;

        case 'Enter':
        case ' ':
          e.preventDefault();
          this.activateFocusedWord();
          break;

        case 'Escape':
          e.preventDefault();
          this.clearFocus();
          break;
      }
    });
  }

  /**
   * Update the list of focusable word elements
   */
  updateWordList() {
    if (!this.mimicContainer) return;
    this._wordElements = Array.from(this.mimicContainer.querySelectorAll('.mimic-word'));
  }

  /**
   * Focus the next word in the list
   */
  focusNextWord() {
    this.updateWordList();
    if (this._wordElements.length === 0) return;

    this._currentFocusIndex = (this._currentFocusIndex + 1) % this._wordElements.length;
    this._wordElements[this._currentFocusIndex].focus();
  }

  /**
   * Focus the previous word in the list
   */
  focusPreviousWord() {
    this.updateWordList();
    if (this._wordElements.length === 0) return;

    this._currentFocusIndex =
      (this._currentFocusIndex - 1 + this._wordElements.length) % this._wordElements.length;
    this._wordElements[this._currentFocusIndex].focus();
  }

  /**
   * Activate the currently focused word (simulate click)
   */
  activateFocusedWord() {
    if (this._currentFocusIndex >= 0 && this._wordElements[this._currentFocusIndex]) {
      this._wordElements[this._currentFocusIndex].click();
    }
  }

  /**
   * Clear focus from all words
   */
  clearFocus() {
    this._currentFocusIndex = -1;
    if (document.activeElement && this._wordElements.includes(document.activeElement)) {
      document.activeElement.blur();
    }
  }

  async init() {
    try {
      // Wait for globals to load
      await window.SubtitleUtils.waitForGlobals();

  // Load initial settings from background storage via RPC
  const data = await window.delegateStorageOp('get', window.STORAGE_SCHEMA);

      this.knownWords = new Set(data.knownWords || []);
      this.unknownWords = new Set(data.unknownWords || []);
      this.isActive = data.isActive !== false;
      this.pauseOnHover = data.pauseOnHover !== false;
      this.knownColor = data.knownColor || '#10b981';
      this.learningColor = data.learningColor || '#f59e0b';

      // Inject dynamic styles
      this.injectDynamicStyles();

      // Initialize accessibility features
      this.initAccessibility();

      // Setup storage change listener
      this.setupStorageListener();

      // Setup message listener
      this.setupMessageHandler();

      // Start system
      this.startSystem();

    } catch (error) {
      console.error('❌ Init error:', error);
      try { if (window && window.toast && typeof window.toast.error === 'function') window.toast.error('Altyazı sistemi başlatılamadı'); } catch(e) {}
    }
  }

  /**
   * Helper function to adjust color brightness for hover effects
   */
  adjustColorBrightness(hex, percent) {
    // Remove # if present
    hex = hex.replace(/^#/, '');

    // Parse r, g, b values
    const num = parseInt(hex, 16);
    const amt = Math.round(2.55 * percent);
    const R = (num >> 16) + amt;
    const G = (num >> 8 & 0x00FF) + amt;
    const B = (num & 0x0000FF) + amt;

    return '#' + (0x1000000 + (R < 255 ? R < 1 ? 0 : R : 255) * 0x10000 +
      (G < 255 ? G < 1 ? 0 : G : 255) * 0x100 +
      (B < 255 ? B < 1 ? 0 : B : 255)).toString(16).slice(1);
  }

  /**
   * Inject dynamic styles based on user settings - ZERO LAYOUT SHIFT, NO GLOW
   */
  injectDynamicStyles() {
    // Remove existing dynamic styles
    const existing = document.getElementById('mimic-dynamic-styles');
    if (existing) existing.remove();

    // Create style element - NO GLOW, NO BACKGROUND ON HOVER
    const style = document.createElement('style');
    style.id = 'mimic-dynamic-styles';
    style.textContent = `
      .mimic-word {
        display: inline;
        transition: none;
        cursor: pointer;
        position: relative;
      }

      .mimic-word:hover {
        /* REMOVED: background and box-shadow to prevent layout shift */
      }

      .known-word {
        color: ${this.knownColor} !important;
        font-weight: 700 !important;
        text-shadow: none !important; /* REMOVED GLOW */
      }

      .known-word:hover {
        color: ${this.adjustColorBrightness(this.knownColor, 20)} !important;
        background: none !important; /* REMOVED BACKGROUND */
        text-shadow: none !important; /* REMOVED GLOW */
      }

      .unknown-word {
        color: ${this.learningColor} !important;
        font-weight: 700 !important;
        text-shadow: none !important; /* REMOVED GLOW */
      }

      .unknown-word:hover {
        color: ${this.adjustColorBrightness(this.learningColor, 20)} !important;
        background: none !important; /* REMOVED BACKGROUND */
        text-shadow: none !important; /* REMOVED GLOW */
      }

      .unmarked-word {
        color: white !important;
        font-weight: inherit !important;
      }
    `;

    document.head.appendChild(style);
    console.log('🎨 Dynamic styles injected (no glow, no layout shift):', { known: this.knownColor, learning: this.learningColor });
  }

  /**
   * Listen for storage changes from popup
   */
  setupStorageListener() {
    // Use chrome.storage.onChanged directly (background is authoritative for writes)
    this._storageChangeHandler = (changes, areaName) => {
      if (areaName !== 'local') return;

      // Update word lists
      if (changes.knownWords) {
        this.knownWords = new Set(changes.knownWords.newValue || []);
      }

      if (changes.unknownWords) {
        this.unknownWords = new Set(changes.unknownWords.newValue || []);
      }

      // Update settings
      if (changes.isActive) {
        this.isActive = changes.isActive.newValue;
      }

      if (changes.pauseOnHover) {
        this.pauseOnHover = changes.pauseOnHover.newValue;
      }

      // Update colors
      if (changes.knownColor || changes.learningColor) {
        this.knownColor = changes.knownColor?.newValue || this.knownColor;
        this.learningColor = changes.learningColor?.newValue || this.learningColor;
        this.injectDynamicStyles();
      }

      // Re-render subtitles
      this.scanAndMirror();
    };

    chrome.storage.onChanged.addListener(this._storageChangeHandler);
  }

  /**
   * Setup message handler for popup communication
   */
  setupMessageHandler() {
    window.setupMessageListener({
      [window.MESSAGE_TYPES.PING]: () => {
        return { active: this.isActive, version: '2.0' };
      },

      [window.MESSAGE_TYPES.GET_STATUS]: () => {
        return {
          isActive: this.isActive,
          knownCount: this.knownWords.size,
          learningCount: this.unknownWords.size
        };
      },

      [window.MESSAGE_TYPES.TOGGLE]: async () => {
        this.isActive = !this.isActive;
        await window.delegateStorageOp('set', { isActive: this.isActive });

        if (this.isActive) {
          this.scanAndMirror();
        } else {
          this.clearMimicLines();
        }

        return { isActive: this.isActive };
      },

      [window.MESSAGE_TYPES.REFRESH]: () => {
        this.scanAndMirror();
        return { refreshed: true };
      },

      [window.MESSAGE_TYPES.WORDS_UPDATED]: async (payload) => {
        this.knownWords = new Set(payload.knownWords || []);
        this.unknownWords = new Set(payload.unknownWords || []);
        this.scanAndMirror();
        return { updated: true };
      },

      [window.MESSAGE_TYPES.SETTINGS_UPDATED]: async (payload) => {
        if (payload.knownColor) this.knownColor = payload.knownColor;
        if (payload.learningColor) this.learningColor = payload.learningColor;
        if (payload.pauseOnHover !== undefined) this.pauseOnHover = payload.pauseOnHover;

        this.injectDynamicStyles();
        this.scanAndMirror();
        return { updated: true };
      }
    });

  }

  startSystem() {
    // Wait for YouTube player
    const waitForPlayer = () => {
      const player = document.querySelector('#movie_player, .html5-video-player');
      if (!player) {
        setTimeout(waitForPlayer, 500);
        return;
      }

      this.setupMimicSystem(player);
    };

    waitForPlayer();
  }

  setupMimicSystem(player) {
    // Step 1: Find native subtitle container
    this.findNativeContainer(player);

    // Step 2: Create our mimic container
    this.createMimicContainer(player);

    // Step 3: Hide native subtitles
    this.hideNativeSubtitles();

    // Step 4: Setup observers
    this.setupObservers();

    // Step 5: Initial scan and mirror
    this.scanAndMirror();

  }

  findNativeContainer(player) {
    // Find caption container
    const container = player.querySelector('.ytp-caption-window-container');
    if (!container) {
      setTimeout(() => this.findNativeContainer(player), 1000);
      return;
    }

    this.nativeContainer = container;
  }

  createMimicContainer(player) {
    // Remove existing mimic if any
    const existing = player.querySelector('.mimic-subtitle-container');
    if (existing) existing.remove();

    // Create mimic container - CENTERED FRAME, LEFT-ALIGNED CONTENT
    this.mimicContainer = document.createElement('div');
    this.mimicContainer.className = 'mimic-subtitle-container';

    // Calculate responsive bottom position
    const getResponsiveBottom = () => {
      const height = window.innerHeight;
      if (height < 480) return '8%';
      if (height < 768) return '10%';
      if (height < 1080) return '12%';
      return '14%';
    };

    this.mimicContainer.style.cssText = `
      position: absolute;
      bottom: ${getResponsiveBottom()};
      left: 0;
      right: 0;
      width: 100%;
      max-width: none;
      display: flex;
      flex-direction: column;
      align-items: center; /* CENTER VISUAL LINES */
      justify-content: center;
      text-align: center; /* center inline-block children */
      gap: 4px;
      z-index: 9999;
      pointer-events: none;
      transition: none;
    `;

    player.appendChild(this.mimicContainer);

    // Update position on resize
    window.addEventListener('resize', () => {
      if (this.mimicContainer) {
        this.mimicContainer.style.bottom = getResponsiveBottom();
        this.mimicContainer.style.maxWidth = '90%';
      }
    });
  }

  hideNativeSubtitles() {
    // Make native subtitles invisible but keep them for tracking
    if (!this.nativeContainer) return;

    this.nativeContainer.style.opacity = '0';
    this.nativeContainer.style.pointerEvents = 'none';
  }

  setupObservers() {
    if (!this.nativeContainer) {
      setTimeout(() => this.setupObservers(), 500);
      return;
    }

    // Observer 1: Structure changes (lines added/removed)
    this.structureObserver = new MutationObserver((mutations) => {
      if (!this.isActive) return;

      let structureChanged = false;

      mutations.forEach(mutation => {
        if (mutation.type === 'childList' && mutation.addedNodes.length > 0) {
          structureChanged = true;
        }
        if (mutation.type === 'childList' && mutation.removedNodes.length > 0) {
          structureChanged = true;
        }
      });

      if (structureChanged) {
        this.onStructureChange();
      }
    });

    // Observer 2: Text changes (word additions)
    this.textObserver = new MutationObserver((mutations) => {
      if (!this.isActive) return;

      mutations.forEach(mutation => {
        if (mutation.type === 'characterData' ||
            (mutation.type === 'childList' && mutation.target.nodeType === Node.TEXT_NODE)) {
          this.onTextChange(mutation.target);
        }
      });
    });

    // Observer 3: Attribute changes (style/class)
    this.attributeObserver = new MutationObserver((mutations) => {
      if (!this.isActive) return;

      mutations.forEach(mutation => {
        if (mutation.type === 'attributes' &&
            (mutation.attributeName === 'style' || mutation.attributeName === 'class')) {
          this.onAttributeChange(mutation.target);
        }
      });
    });

    // Start observing
    this.structureObserver.observe(this.nativeContainer, {
      childList: true,
      subtree: true
    });

    this.textObserver.observe(this.nativeContainer, {
      characterData: true,
      subtree: true,
      childList: true
    });

    this.attributeObserver.observe(this.nativeContainer, {
      attributes: true,
      subtree: true,
      attributeFilter: ['style', 'class']
    });

  }

  // Event Handlers

  onStructureChange(mutations) {
    // If no mutations provided, fallback to full rescan
    if (!mutations || mutations.length === 0) {
      this.scanAndMirror();
      return;
    }

    const addedLines = [];
    const removedLines = [];

    mutations.forEach(m => {
      if (m.type !== 'childList') return;

      m.addedNodes.forEach(node => {
        try {
          if (node.matches && node.matches('.caption-visual-line, .ytp-caption-segment')) {
            addedLines.push(node);
          } else if (node.querySelectorAll) {
            // Some added nodes are containers; find child lines
            const found = node.querySelectorAll('.caption-visual-line, .ytp-caption-segment');
            found.forEach(n => addedLines.push(n));
          }
        } catch (e) {
          // Ignore any matching errors
        }
      });

      m.removedNodes.forEach(node => {
        try {
          if (node.matches && node.matches('.caption-visual-line, .ytp-caption-segment')) {
            removedLines.push(node);
          } else if (node.querySelectorAll) {
            const found = node.querySelectorAll('.caption-visual-line, .ytp-caption-segment');
            found.forEach(n => removedLines.push(n));
          }
        } catch (e) {}
      });
    });

    // If many changes, fallback to full scan to avoid complex diff logic
    const totalChanges = addedLines.length + removedLines.length;
    if (totalChanges === 0) return; // nothing to do
    if (totalChanges > 8) { // threshold: if too many, do full rescan
      this.scanAndMirror();
      return;
    }

    try {
      this.updateIncrementally(addedLines, removedLines);
    } catch (err) {
      console.error('[PerfectMimic] incremental update failed, falling back to full rescan', err);
      this.scanAndMirror();
    }
  }

  /**
   * Update mimic lines incrementally using a single fresh scan of native lines.
   * - Updates existing lines in-place
   * - Appends newly added lines
   * - Removes deleted lines
   * Falls back to full rebuild on ambiguity.
   */
  updateIncrementally(addedLines, removedLines) {
    // Perform one fresh scan to get current ordered native lines
    const nativeLines = this.scanNativeLines();

    // Quick sanity check
    if (!Array.isArray(nativeLines)) {
      this.scanAndMirror();
      return;
    }

    const newCount = nativeLines.length;
    const oldCount = this.mimicLines.length || 0;

    // If no mimic container yet, just rebuild
    if (!this.mimicContainer) {
      this.rebuildMimicLines(nativeLines);
      this.domState.lineCount = newCount;
      return;
    }

    // Update overlapping range
    const minCount = Math.min(oldCount, newCount);
    for (let i = 0; i < minCount; i++) {
      this.updateMimicLineText(i, nativeLines[i].text);
      this.mirrorLineStyles(i, nativeLines[i].element);
    }

    // Append additional new lines
    if (newCount > oldCount) {
      for (let i = oldCount; i < newCount; i++) {
        const mimicLine = this.createMimicLine(nativeLines[i]);
        this.mimicContainer.appendChild(mimicLine);
        this.mimicLines.push(mimicLine);
      }
    }

    // Remove surplus old lines
    if (newCount < oldCount) {
      for (let i = oldCount - 1; i >= newCount; i--) {
        const node = this.mimicLines[i];
        try { if (node && node.parentNode) node.parentNode.removeChild(node); } catch (e) {}
        this.mimicLines.pop();
      }
    }

    // Update domState
    this.domState.lineCount = newCount;
  }

  onTextChange(node) {
    // Find which line this text belongs to
    const lineElement = node.parentElement?.closest('.ytp-caption-segment, .caption-visual-line');
    if (!lineElement) return;

    const lineIndex = this.findNativeLineIndex(lineElement);
    if (lineIndex === -1) return;

    const newText = this.extractLineText(lineElement);
    this.updateMimicLineText(lineIndex, newText);
  }

  onAttributeChange(element) {
    // Find which line this belongs to
    const lineElement = element.closest('.caption-visual-line, .ytp-caption-segment');
    if (!lineElement) return;

    const lineIndex = this.findNativeLineIndex(lineElement);
    if (lineIndex === -1) return;

    this.mirrorLineStyles(lineIndex, lineElement);
  }

  // Core Mirroring Logic

  scanAndMirror() {
    // Scan native subtitle structure
    const nativeLines = this.scanNativeLines();


    // Update our DOM state
    const lineCountChanged = nativeLines.length !== this.domState.lineCount;

    if (lineCountChanged) {
      this.rebuildMimicLines(nativeLines);
    } else {
      // Just update existing lines
      nativeLines.forEach((nativeLine, index) => {
        this.updateMimicLineText(index, nativeLine.text);
        this.mirrorLineStyles(index, nativeLine.element);
      });
    }

    this.domState.lineCount = nativeLines.length;
  }

  scanNativeLines() {
    if (!this.nativeContainer) return [];

    const lines = [];
    const seenTexts = new Set(); // Prevent duplicates

    // Find all caption lines - prefer .caption-visual-line (containers)
    const lineElements = this.nativeContainer.querySelectorAll('.caption-visual-line');

    if (lineElements.length === 0) {
      // Fallback to segments if no visual lines
      const segments = this.nativeContainer.querySelectorAll('.ytp-caption-segment');
      segments.forEach(element => {
        const text = this.extractLineText(element);
        if (text.trim() && !seenTexts.has(text)) {
          seenTexts.add(text);
          lines.push({
            element: element,
            text: text,
            styles: window.getComputedStyle(element)
          });
        }
      });
    } else {
      // Use visual lines (preferred)
      lineElements.forEach(element => {
        const text = this.extractLineText(element);
        if (text.trim() && !seenTexts.has(text)) {
          seenTexts.add(text);
          lines.push({
            element: element,
            text: text,
            styles: window.getComputedStyle(element)
          });
        }
      });
    }

    // Sort by vertical position (top to bottom)
    lines.sort((a, b) => {
      const rectA = a.element.getBoundingClientRect();
      const rectB = b.element.getBoundingClientRect();
      return rectA.top - rectB.top;
    });

    return lines;
  }

  extractLineText(element) {
    // Get all text content from element
    return element.textContent?.trim() || '';
  }

  findNativeLineIndex(element) {
    const lines = this.scanNativeLines();
    return lines.findIndex(line =>
      line.element === element || line.element.contains(element)
    );
  }

  rebuildMimicLines(nativeLines) {

  // Clear existing mimic lines (remove children safely)
  if (this.mimicContainer) this.mimicContainer.textContent = '';
    this.mimicLines = [];

    // Create mimic line for each native line
    nativeLines.forEach((nativeLine, index) => {
      const mimicLine = this.createMimicLine(nativeLine);
      this.mimicContainer.appendChild(mimicLine);
      this.mimicLines.push(mimicLine);
    });

  }

  createMimicLine(nativeLine) {
    const mimicLine = document.createElement('div');
    mimicLine.className = 'mimic-line';

    // LEFT ALIGNED WORDS, NO CENTERING - FIT CONTENT
    // NOTE: move visual styling (background/padding) to .mimic-segment to avoid
    // per-word layout shifts. mimicLine now acts as an inline container only.
    mimicLine.style.cssText = `
      position: relative;
      display: inline-block; /* match YouTube visual-line behavior */
      vertical-align: bottom;
      padding: 0;
      margin: 0;
      background: transparent;
      border-radius: 0;
      font-family: Netflix Sans, Helvetica Neue, Segoe UI, Roboto, Ubuntu, sans-serif;
      font-weight: 500;
      line-height: 1.4;
      text-align: left; /* inner content left aligned */
      letter-spacing: 0.01em;
      color: #ffffff;
      white-space: pre-wrap;
      word-wrap: break-word;
      word-break: break-word;
      pointer-events: auto;
      transition: none;
      width: auto; /* FIT CONTENT */
      max-width: none; /* NO MAX WIDTH LIMIT */
    `;

    // Set initial text with colorization
    this.setMimicLineContent(mimicLine, nativeLine.text);

    return mimicLine;
  }

  updateMimicLineText(lineIndex, newText) {
    if (lineIndex < 0 || lineIndex >= this.mimicLines.length) return;

    const mimicLine = this.mimicLines[lineIndex];
    const currentText = mimicLine.textContent;

    // Only update if text actually changed
    if (currentText === newText) return;

    this.setMimicLineContent(mimicLine, newText);
  }

  setMimicLineContent(mimicLine, text) {
    // Build content using safe DOM APIs (avoid innerHTML to prevent XSS)
    const fragment = document.createDocumentFragment();

    if (!text) {
      // Clear children safely
      mimicLine.textContent = '';
      return;
    }

    // Create a segment wrapper (mimic-segment) which will carry background and padding
    const words = this.extractWordsWithPositions(text);
    const segment = document.createElement('span');
    segment.className = 'mimic-segment';

    if (!words || words.length === 0) {
      segment.appendChild(document.createTextNode(text));
    } else {
      let lastIndex = 0;
      for (const wordInfo of words) {
        if (wordInfo.start > lastIndex) {
          segment.appendChild(document.createTextNode(text.slice(lastIndex, wordInfo.start)));
        }

        const cleanWord = wordInfo.word.toLowerCase();
        const isKnown = this.knownWords.has(cleanWord);
        const isUnknown = this.unknownWords.has(cleanWord);

        const span = document.createElement('span');
        if (this.validateClassName('mimic-word')) span.className = 'mimic-word';

  if (isKnown && this.validateClassName('known-word')) span.classList.add('known-word');
  else if (isUnknown && this.validateClassName('unknown-word')) span.classList.add('unknown-word');
        else if (this.validateClassName('unmarked-word')) span.classList.add('unmarked-word');

        span.setAttribute('role', 'button');
        span.setAttribute('tabindex', '0');
        span.setAttribute('aria-label', `${isKnown ? 'Known' : isUnknown ? 'Learning' : 'Unmarked'} word: ${wordInfo.text}. Press Enter or Space to view options`);

        span.dataset.word = cleanWord;
        span.textContent = wordInfo.text;

        segment.appendChild(span);
        lastIndex = wordInfo.end;
      }

      if (lastIndex < text.length) {
        segment.appendChild(document.createTextNode(text.slice(lastIndex)));
      }
    }

    fragment.appendChild(segment);

  // Atomic replace (clear then append fragment)
  mimicLine.textContent = '';
  mimicLine.appendChild(fragment);

    // Setup click handlers
    this.setupWordClickHandlers(mimicLine);
  }

  mirrorLineStyles(lineIndex, nativeElement) {
    if (lineIndex < 0 || lineIndex >= this.mimicLines.length) return;

    const mimicLine = this.mimicLines[lineIndex];
    const computedStyle = window.getComputedStyle(nativeElement);

    // Mirror critical styles only
    const stylesToMirror = ['transform', 'opacity', 'transition'];

    stylesToMirror.forEach(prop => {
      mimicLine.style[prop] = computedStyle[prop];
    });
  }

  createColorizedHTML(text) {
    if (!text) return '';

    const words = this.extractWordsWithPositions(text);
    if (words.length === 0) return window.SubtitleUtils.escapeHtml(text);

    let html = '';
    let lastIndex = 0;

    words.forEach(wordInfo => {
      // Add text before word
      if (wordInfo.start > lastIndex) {
        html += window.SubtitleUtils.escapeHtml(text.slice(lastIndex, wordInfo.start));
      }

      // Check if word is marked
      const cleanWord = wordInfo.word.toLowerCase();
      const isKnown = this.knownWords.has(cleanWord);
      const isUnknown = this.unknownWords.has(cleanWord);

      if (isKnown || isUnknown) {
        // Word is marked - wrap in span with color class
        const wordClass = isKnown ? 'known-word' : 'unknown-word';
        html += `<span class="mimic-word ${wordClass}" data-word="${window.SubtitleUtils.escapeHtml(cleanWord)}">${window.SubtitleUtils.escapeHtml(wordInfo.text)}</span>`;
      } else {
        // Word is not marked - render as plain text (clickable for marking)
        html += `<span class="mimic-word unmarked-word" data-word="${window.SubtitleUtils.escapeHtml(cleanWord)}">${window.SubtitleUtils.escapeHtml(wordInfo.text)}</span>`;
      }

      lastIndex = wordInfo.end;
    });

    // Add remaining text
    if (lastIndex < text.length) {
      html += window.SubtitleUtils.escapeHtml(text.slice(lastIndex));
    }

    return html;
  }

  extractWordsWithPositions(text) {
    const words = [];
    const wordRegex = /[\p{L}\d]+(?:['\u2019-][\p{L}\d]+)*/gu;
    let match;

    while ((match = wordRegex.exec(text)) !== null) {
      words.push({
        word: match[0].toLowerCase(),
        text: match[0],
        start: match.index,
        end: match.index + match[0].length
      });
    }

    return words;
  }

  getWordClass(word) {
    const cleanWord = word.toLowerCase();

    if (this.knownWords.has(cleanWord)) {
      return 'known-word';
    } else if (this.unknownWords.has(cleanWord)) {
      return 'unknown-word';
    } else {
      return 'neutral-word';
    }
  }

  setupWordClickHandlers(mimicLine) {
    const wordSpans = mimicLine.querySelectorAll('.mimic-word');

    wordSpans.forEach(span => {
      // Use tracked listeners so we can remove them later
      this._addTrackedListener(span, 'click', function (e) {
        e.stopPropagation();
        console.debug('🖱️ mimic-word clicked (span.dataset.word):', this.dataset.word, this);
        // Forward to instance method
        // eslint-disable-next-line no-unused-expressions
        (this.__perfectMimicInstance || window.perfectMimic)?.menuSystem?.showWordMenu(this, e);
      }.bind(span));

      if (this.pauseOnHover) {
        this._addTrackedListener(span, 'mouseenter', () => this.pauseVideo());
        this._addTrackedListener(span, 'mouseleave', () => this.resumeVideo());
      }
    });
  }

  /**
   * Track and add an event listener so it can be cleaned up later.
   * element: DOM Element
   * event: string
   * handler: Function (already bound if necessary)
   */
  _addTrackedListener(element, event, handler) {
    element.addEventListener(event, handler);

    let arr = this._trackedListeners.get(element);
    if (!arr) {
      arr = [];
      this._trackedListeners.set(element, arr);
    }

    arr.push({ event, handler });
  }

  /**
   * Remove all tracked listeners and observers and DOM created by this instance.
   */
  destroy() {
    // Remove tracked listeners
    try {
      this._trackedListeners.forEach((listeners, element) => {
        listeners.forEach(({ event, handler }) => {
          try { element.removeEventListener(event, handler); } catch (e) { /* ignore */ }
        });
      });
      this._trackedListeners.clear();
    } catch (e) {
      console.warn('Error cleaning tracked listeners', e);
    }

    // Disconnect observers
    try { this.structureObserver?.disconnect(); } catch (e) { /* ignore */ }
    try { this.textObserver?.disconnect(); } catch (e) { /* ignore */ }
    try { this.attributeObserver?.disconnect(); } catch (e) { /* ignore */ }

    // Clear timeouts
    try { this.menuTimeouts.forEach(t => clearTimeout(t)); this.menuTimeouts = []; } catch (e) { }

    // Remove mimic container
    try { if (this.mimicContainer && this.mimicContainer.parentNode) this.mimicContainer.parentNode.removeChild(this.mimicContainer); } catch (e) { }
    this.mimicContainer = null;
    this.mimicLines = [];

    // Remove storage change listener if attached
    try {
      if (this._storageChangeHandler) {
        chrome.storage.onChanged.removeListener(this._storageChangeHandler);
        this._storageChangeHandler = null;
      }
    } catch (e) {
      // ignore
    }

    // Remove any global references
    try { if (window.perfectMimic === this) window.perfectMimic = null; } catch (e) { }
  }

  pauseVideo() {
    const video = document.querySelector('video');
    if (video && !video.paused) {
      video.pause();
    }
  }

  resumeVideo() {
    const video = document.querySelector('video');
    if (video && video.paused) {
      video.play();
    }
  }

  clearMimicLines() {
    if (this.mimicContainer) {
      this.mimicContainer.textContent = '';
      this.mimicLines = [];
    }
  }

  // Debug methods
  getStats() {
    return {
      knownWords: this.knownWords.size,
      unknownWords: this.unknownWords.size,
      isActive: this.isActive,
      nativeLines: this.scanNativeLines().length,
      mimicLines: this.mimicLines.length,
      observers: {
        structure: !!this.structureObserver,
        text: !!this.textObserver,
        attribute: !!this.attributeObserver
      },
      storage: {
        initialized: this.storage?.initialized,
        cacheKeys: this.storage?.cache ? Object.keys(this.storage.cache) : null
      }
    };
  }

  // Console command: window.perfectMimic.testWord('hello')
  async testWord(word) {
    console.log('🧪 Testing word:', word);
    console.log('Before:', {
      knownWords: Array.from(this.knownWords),
      unknownWords: Array.from(this.unknownWords)
    });

    await this.markAsKnown(word);

    console.log('After:', {
      knownWords: Array.from(this.knownWords),
      unknownWords: Array.from(this.unknownWords)
    });

    const dump = await this.storage.export();
    console.log('Storage:', dump);

    return dump;
  }

  toggle() {
    this.isActive = !this.isActive;
    this.mimicContainer.style.display = this.isActive ? 'flex' : 'none';
  }

  forceRescan() {
    this.scanAndMirror();
  }
};