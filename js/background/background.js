// Background service worker for YouTube Subtitle Colorer
chrome.runtime.onInstalled.addListener(() => {
  console.log('SubFlow extension installed');
});

// Ensure storage manager is available in the background context.
// importScripts is synchronous in service workers for importing plain scripts.
try {
  importScripts('/js/storage/storage-manager.js');
  console.log('[Background] storage-manager imported');
} catch (e) {
  console.warn('[Background] Could not import storage-manager via importScripts:', e);
}

// Handle messages from content script and popup
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.type === 'wordUpdate') {
    // Forward the update to popup if it's open
    chrome.runtime.sendMessage(request).catch(() => {
      // Popup might not be open, that's okay
    });
  }

  // Handle delegated storage operations from content scripts
  if (request.type === 'storageMove') {
    const { fromKey, toKey, item } = request;

    if (globalThis && globalThis.storageManager && typeof globalThis.storageManager.moveToSet === 'function') {
      globalThis.storageManager.moveToSet(fromKey, toKey, item)
        .then(() => {
          sendResponse({ ok: true });
        })
        .catch(err => {
          console.error('[Background] storageMove failed:', err);
          sendResponse({ ok: false, error: err && err.message });
        });

      // Keep the message channel open for async response
      return true;
    } else {
      console.error('[Background] storageMove requested but no storageManager available');
      sendResponse({ ok: false, error: 'No storageManager in background' });
    }
  }
  
  // Generic storage RPC for content scripts and popup
  if (request.type === 'storageOp') {
    const { op, args } = request;

  // Simple debounced write buffer for 'set' operations
  // pendingWrites is a shallow merge object of the latest values to write
  if (!globalThis._pendingWrites) globalThis._pendingWrites = {};
  if (!globalThis._pendingFlushTimer) globalThis._pendingFlushTimer = null;
  if (!globalThis._flushAttempt) globalThis._flushAttempt = 0;
  // Telemetry / metrics for flushes
  if (!globalThis._flushMetrics) globalThis._flushMetrics = { flushedCount: 0, failedFlushCount: 0, lastFlushAt: null, lastFlushError: null };
  // Configurable delay for debounce (ms)
  if (!globalThis._pendingFlushDelay) globalThis._pendingFlushDelay = 100;

    const scheduleFlush = (delay = undefined) => {
      const d = typeof delay === 'number' ? delay : globalThis._pendingFlushDelay;
      if (globalThis._pendingFlushTimer) clearTimeout(globalThis._pendingFlushTimer);
      globalThis._pendingFlushTimer = setTimeout(() => {
        flushPendingWrites().catch(err => console.error('[Background] flushPendingWrites error:', err));
      }, d);
    };

    const flushPendingWrites = async (attempt = 1) => {
      // No-op if nothing to flush
      if (!globalThis._pendingWrites || Object.keys(globalThis._pendingWrites).length === 0) return;

      // Prevent concurrent flush runs
      if (globalThis._flushInProgress) return;
      globalThis._flushInProgress = true;

      // Snapshot current pending writes and clear buffer so new writes can accumulate
      const toWrite = { ...globalThis._pendingWrites };
      globalThis._pendingWrites = {};

      const keys = Object.keys(toWrite);
      if (keys.length === 0) {
        globalThis._flushInProgress = false;
        return;
      }

      const chunkSize = 20; // simple granularity: write up to 20 keys per chunk

      // Helper to write a single chunk with retry/backoff
      const writeChunkWithRetry = async (chunkObj, chunkAttempt = 1) => {
        try {
          await callMethod('set', chunkObj);
          globalThis._flushMetrics.flushedCount = (globalThis._flushMetrics.flushedCount || 0) + 1;
          globalThis._flushMetrics.lastFlushAt = Date.now();
          globalThis._flushMetrics.lastFlushError = null;
          console.log('[Background] Flushed chunk keys:', Object.keys(chunkObj));
          return true;
        } catch (err) {
          console.error(`[Background] Failed chunk flush attempt ${chunkAttempt}:`, err);
          globalThis._flushMetrics.lastFlushAt = Date.now();
          globalThis._flushMetrics.lastFlushError = err && err.message;
          if (chunkAttempt < 3) {
            const backoff = 100 * Math.pow(2, chunkAttempt - 1);
            await new Promise(r => setTimeout(r, backoff));
            return writeChunkWithRetry(chunkObj, chunkAttempt + 1);
          }
          // Permanent failure for this chunk
          globalThis._flushMetrics.failedFlushCount = (globalThis._flushMetrics.failedFlushCount || 0) + 1;
          throw err;
        }
      };

      try {
        for (let i = 0; i < keys.length; i += chunkSize) {
          const chunkKeys = keys.slice(i, i + chunkSize);
          const chunkObj = {};
          for (const k of chunkKeys) chunkObj[k] = toWrite[k];

          // Attempt to write this chunk
          await writeChunkWithRetry(chunkObj);
        }

        // All chunks flushed
        globalThis._flushAttempt = 0;
        return true;
      } catch (err) {
        // On failure, re-merge toWrite back into pendingWrites so nothing is lost.
        // Newer writes that arrived during the flush should win -- merge so
        // newer keys override older ones: existing pending writes are spread last.
        globalThis._pendingWrites = { ...toWrite, ...globalThis._pendingWrites };
        globalThis._flushAttempt = 0;
        console.error('[Background] flushPendingWrites permanent failure:', err);
        throw err;
      } finally {
        globalThis._flushInProgress = false;
      }
    };

    // Helper to safe-call the storageManager method
    const callMethod = async (method, ...margs) => {
      if (!globalThis || !globalThis.storageManager || typeof globalThis.storageManager[method] !== 'function') {
        throw new Error('No storageManager in background');
      }
      return globalThis.storageManager[method](...margs);
    };

    (async () => {
      try {
        // Ensure storageManager is initialized in background before any op
        if (!globalThis || !globalThis.storageManager) {
          throw new Error('No storageManager in background');
        }

        if (!globalThis.storageManager.initialized) {
          try {
            const initSchema = (op === 'get' && args && typeof args === 'object') ? args : {};
            await globalThis.storageManager.initialize(initSchema);
            console.log('[Background] storageManager initialized via RPC handler');
          } catch (initErr) {
            console.warn('[Background] storageManager initialization failed in RPC handler:', initErr);
            // proceed; callMethod will throw a clear error if still uninitialized
          }
        }

        let result;
        switch (op) {
          case 'get':
            result = await callMethod('get', args);
            break;
          case 'set':
            // Instead of immediate write, merge into pendingWrites and schedule flush
            if (args && typeof args === 'object') {
              globalThis._pendingWrites = { ...globalThis._pendingWrites, ...args };
              scheduleFlush(100);
              result = { mergedKeys: Object.keys(args) };
            } else {
              result = await callMethod('set', args);
            }
            break;
          case 'addToSet':
            result = await callMethod('addToSet', args.key, args.item);
            break;
          case 'removeFromSet':
            result = await callMethod('removeFromSet', args.key, args.item);
            break;
          case 'moveToSet':
            result = await callMethod('moveToSet', args.fromKey, args.toKey, args.item);
            break;
          case 'export':
            result = await callMethod('export');
            break;
          case 'status':
            // Return pending keys and flush metrics
            result = {
              pendingKeys: Object.keys(globalThis._pendingWrites || {}),
              pendingCount: Object.keys(globalThis._pendingWrites || {}).length,
              flushMetrics: globalThis._flushMetrics || {}
            };
            break;
          case 'setFlushDelay':
            // args = { delay: number }
            if (args && typeof args.delay === 'number') {
              globalThis._pendingFlushDelay = args.delay;
              result = { ok: true, delay: globalThis._pendingFlushDelay };
            } else {
              result = { ok: false, error: 'Invalid delay' };
            }
            break;
          case 'flush':
            await flushPendingWrites();
            result = { flushed: true };
            break;
          case 'flushNow':
            if (globalThis._pendingFlushTimer) { clearTimeout(globalThis._pendingFlushTimer); globalThis._pendingFlushTimer = null; }
            await flushPendingWrites();
            result = { flushed: true };
            break;
          default:
            throw new Error('Unknown storage op: ' + op);
        }
        sendResponse({ ok: true, result });
      } catch (err) {
        console.error('[Background][storageOp] Error:', err);
        sendResponse({ ok: false, error: err && err.message });
      }
    })();

    return true; // async response
  }
});

// Keep the service worker alive
chrome.runtime.onStartup.addListener(() => {
  console.log('SubFlow extension started');
});