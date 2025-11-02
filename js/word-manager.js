// 🎭 Word Manager - Word state management and actions

// Make class globally available
globalThis.WordManager = class WordManager {
  // Initialize queue as a class field to avoid async work inside the constructor
  _syncQueue = Promise.resolve();

  constructor(subtitleSystem) {
    this.system = subtitleSystem;
    // Promise-based FIFO queue to serialize storage/UI sync operations
    this.pendingSync = null; // Debounced sync (kept for compatibility)
  }
  async _enqueueSync(jobFn) {
    // Chain jobs so they run sequentially. Any thrown error is logged but
    // doesn't break the queue chain (we keep it resolving to allow future work).
    this._syncQueue = this._syncQueue.then(() => jobFn()).catch(err => {
      console.error('[WordManager] queued job error:', err);
    });
    return this._syncQueue;
  }

  // Best-effort visual animation for a clicked word
  async _animateClick(wordSpan) {
    if (!wordSpan) return;
    try {
      wordSpan.style.transform = 'scale(1.15)';
      setTimeout(() => {
        try {
          wordSpan.style.transform = 'scale(1)';
        } catch (error_) {
          console.debug('[WordManager] animation restore failed', error_);
        }
      }, 150);
    } catch (error_) {
      console.debug('[WordManager] animation start failed', error_);
    }
  }

  // Perform the storage transition for a given nextState. This is extracted
  // so the main handler stays small and lower in cognitive complexity.
  async _applyStateTransition(word, nextState, wordSpan) {
    switch (nextState) {
      case globalThis.WORD_STATES.KNOWN:
        await globalThis.delegateStorageOp('moveToSet', { fromKey: 'unknownWords', toKey: 'knownWords', item: word });
        this.system.knownWords.add(word);
        this.system.unknownWords.delete(word);
        if (wordSpan) wordSpan.className = `mimic-word ${globalThis.WORD_CLASSES[globalThis.WORD_STATES.KNOWN]}`;
        break;
      case globalThis.WORD_STATES.LEARNING:
        await globalThis.delegateStorageOp('moveToSet', { fromKey: 'knownWords', toKey: 'unknownWords', item: word });
        this.system.unknownWords.add(word);
        this.system.knownWords.delete(word);
        if (wordSpan) wordSpan.className = `mimic-word ${globalThis.WORD_CLASSES[globalThis.WORD_STATES.LEARNING]}`;
        break;
      case globalThis.WORD_STATES.UNMARKED:
        await globalThis.delegateStorageOp('removeFromSet', { key: 'knownWords', item: word });
        await globalThis.delegateStorageOp('removeFromSet', { key: 'unknownWords', item: word });
        this.system.knownWords.delete(word);
        this.system.unknownWords.delete(word);
        if (wordSpan) wordSpan.className = `mimic-word ${globalThis.WORD_CLASSES[globalThis.WORD_STATES.UNMARKED]}`;
        break;
      default:
        break;
    }
  }

  // If local context becomes invalidated, try delegating the move to background
  _delegateMoveOnInvalidated(nextState, word) {
    try {
      const fromKey = (nextState === globalThis.WORD_STATES.KNOWN ? 'unknownWords' : 'knownWords');
      const toKey = (nextState === globalThis.WORD_STATES.KNOWN ? 'knownWords' : 'unknownWords');
      chrome.runtime.sendMessage({ type: 'storageMove', fromKey, toKey, item: word });
    } catch (error_) {
      console.error('[WordManager] delegation failed:', error_);
    }
  }

  async handleWordClick(wordSpan) {
    const word = wordSpan?.dataset?.word;
    if (!word) return;

    return this._enqueueSync(async () => {
      await this._animateClick(wordSpan);

      const currentState = globalThis.getWordState(word, this.system.knownWords, this.system.unknownWords);
      const nextState = globalThis.getNextWordState(currentState);

      try {
        await this._applyStateTransition(word, nextState, wordSpan);
        this.updateAllWordInstances(word);
      } catch (err) {
        console.error('[WordManager] handleWordClick storage error:', err);
        if (err?.message?.includes('Extension context invalidated')) {
          this._delegateMoveOnInvalidated(nextState, word);
        }
        try { if (globalThis?.toast?.error) globalThis.toast.error('Kelime güncellenemedi'); } catch (error_) { console.debug('[WordManager] toast failed', error_); }
      }
    });
  }

  async markAsKnown(word) {
  console.debug('[Action] markAsKnown invoked for', word);
    // Enqueue atomic mark-as-known operation
    return this._enqueueSync(async () => {
      try {
        await globalThis.delegateStorageOp('moveToSet', { fromKey: 'unknownWords', toKey: 'knownWords', item: word });
        this.system.knownWords.add(word);
        this.system.unknownWords.delete(word);
        this.updateAllWordInstances(word);
        console.log('✅ Marked as known:', word);
      } catch (err) {
        console.error('❌ [ERROR] markAsKnown failed for', word, ':', err);
        if (err?.message?.includes('Extension context invalidated')) {
          try {
            chrome.runtime.sendMessage({ type: 'storageMove', fromKey: 'unknownWords', toKey: 'knownWords', item: word });
            this.system.knownWords.add(word);
            this.system.unknownWords.delete(word);
            this.updateAllWordInstances(word);
            console.log('ℹ️ Delegated moveToSet to background for', word);
            return;
          } catch (error_) {
            console.error('❌ Failed delegating to background:', error_);
          }
        }
        try { if (globalThis?.toast?.error) globalThis.toast.error('İşlem başarısız'); } catch (error_) { console.debug('[WordManager] toast failed', error_); }
      }
    });
  }

  async markAsUnknown(word) {
  console.debug('[Action] markAsUnknown invoked for', word);
    return this._enqueueSync(async () => {
      try {
        await globalThis.delegateStorageOp('moveToSet', { fromKey: 'knownWords', toKey: 'unknownWords', item: word });
        this.system.unknownWords.add(word);
        this.system.knownWords.delete(word);
        this.updateAllWordInstances(word);
        console.log('📖 Marked as learning:', word);
      } catch (err) {
        console.error('❌ [ERROR] markAsUnknown failed for', word, ':', err);
        if (err?.message?.includes('Extension context invalidated')) {
          try {
            chrome.runtime.sendMessage({ type: 'storageMove', fromKey: 'knownWords', toKey: 'unknownWords', item: word });
            this.system.unknownWords.add(word);
            this.system.knownWords.delete(word);
            this.updateAllWordInstances(word);
            console.log('ℹ️ Delegated moveToSet to background for', word);
            return;
          } catch (error_) {
            console.error('❌ Failed delegating to background:', error_);
          }
        }
        try { if (globalThis?.toast?.error) globalThis.toast.error('İşlem başarısız'); } catch (error_) { console.debug('[WordManager] toast failed', error_); }
      }
    });
  }

  async removeFromList(word) {
    console.debug('[Action] removeFromList invoked for', word);
    return this._enqueueSync(async () => {
      try {
        const knownArray = Array.from(this.system.knownWords).filter(w => w !== word);
        const unknownArray = Array.from(this.system.unknownWords).filter(w => w !== word);
        await globalThis.delegateStorageOp('set', { knownWords: knownArray, unknownWords: unknownArray });
        this.system.knownWords.delete(word);
        this.system.unknownWords.delete(word);
        this.updateAllWordInstances(word);
        console.log('🗑️ Removed from lists:', word);
      } catch (err) {
        console.error('❌ [ERROR] removeFromList failed for', word, ':', err);
        try { if (globalThis?.toast?.error) globalThis.toast.error('Kelime listeden silinemedi'); } catch (error_) { console.debug('[WordManager] toast failed', error_); }
      }
    });
  }

  getWordStatus(word) {
    return globalThis.getWordState(word, this.system.knownWords, this.system.unknownWords);
  }

  updateAllWordInstances(word) {
    // Update all instances of this word in all lines
    const allWords = this.system.mimicContainer.querySelectorAll(`.mimic-word[data-word="${word}"]`);
    const state = globalThis.getWordState(word, this.system.knownWords, this.system.unknownWords);
    const className = globalThis.WORD_CLASSES[state];

    console.debug('🔁 updateAllWordInstances:', {
      word,
      found: allWords.length,
      state,
      className,
      WORD_CLASSES: globalThis.WORD_CLASSES
    });

    let index = 0;
    for (const span of allWords) {
      const oldClass = span.className;
      span.className = `mimic-word ${className}`;
      console.debug(`  [${index}] Updated:`, oldClass, '→', span.className, span);
      index += 1;
    }
  }
};