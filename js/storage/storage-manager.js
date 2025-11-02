/**
 * 🔒 STORAGE MANAGER
 * Queue-based storage system to prevent race conditions
 * All storage operations go through a single queue
 */

class StorageManager {
  constructor() {
    // Promise queue for sequential operations
    this.queue = Promise.resolve();
    
    // In-memory cache to prevent overwrites
    this.cache = null;
    
    // Flag to track initialization
    this.initialized = false;
  }

  /**
   * Initialize storage manager by loading all data into cache
   * Must be called before any other operations
   */
  async initialize(schema) {
    if (this.initialized) return this.cache;

    const resultPromise = this.queue.then(async () => {
      const data = await chrome.storage.local.get(schema);
      this.cache = data;
      this.initialized = true;
      console.log('[StorageManager] Initialized with cache:', this.cache);
      return this.cache;
    });
    
    this.queue = resultPromise;
    return resultPromise;
  }

  /**
   * Get data from storage
   * Uses cache if available, otherwise reads from chrome.storage
   * @param {string|string[]|Object} keys - Keys to retrieve
   * @returns {Promise<Object>} Retrieved data
   */
  async get(keys) {
    const resultPromise = this.queue.then(async () => {
      if (!this.initialized) {
        throw new Error('[StorageManager] Not initialized! Call initialize() first.');
      }

      // If keys is an object (default values), extract just the keys
      const keyList = typeof keys === 'object' && !Array.isArray(keys) 
        ? Object.keys(keys) 
        : Array.isArray(keys) 
          ? keys 
          : [keys];

      // Return from cache
      const result = {};
      for (const key of keyList) {
        result[key] = this.cache[key];
      }

      console.log('[StorageManager] GET:', keyList, '→', result);
      return result;
    });
    
    this.queue = resultPromise;
    return resultPromise;
  }

  /**
   * Set data to storage (INTERNAL - doesn't add to queue)
   * Merges with cache to prevent overwrites
   * @param {Object} items - Key-value pairs to save
   * @returns {Promise<void>}
   */
  async _setInternal(items, options = {}) {
    if (!this.initialized) {
      throw new Error('[StorageManager] Not initialized! Call initialize() first.');
    }

    const { skipRemoteRead = false } = options;

    // If caller already read the freshest remote state (e.g. moveToSet),
    // allow skipping the extra remote read to avoid double reads and races.
    let baseRemote;
    if (skipRemoteRead) {
      // Use our cached view as the base to merge against.
      baseRemote = { ...(this.cache || {}) };
    } else {
      baseRemote = await chrome.storage.local.get();
    }

    // Merge remote/base state with our items, giving priority to items
    const merged = { ...baseRemote, ...items };

    // Write merged state back to storage
    await chrome.storage.local.set(merged);

    // Update cache to the freshly written merged state
    this.cache = merged;

    console.log('[StorageManager] SET (merged with remote):', Object.keys(items), '→ Success (skipRemoteRead=', skipRemoteRead, ')');
  }

  /**
   * Set data to storage (PUBLIC API)
   * Merges with cache to prevent overwrites
   * @param {Object} items - Key-value pairs to save
   * @returns {Promise<void>}
   */
  async set(items) {
    // Add to queue and return the result
    const resultPromise = this.queue.then(async () => {
      await this._setInternal(items);
    });
    
    // Update queue for next operation
    this.queue = resultPromise;
    
    // Return the result (not the queue!)
    return resultPromise;
  }

  /**
   * Update a specific key using an update function
   * Prevents race conditions by operating on latest cached value
   * @param {string} key - Key to update
   * @param {Function} updateFn - Function that takes current value and returns new value
   * @returns {Promise<*>} Updated value
   */
  async update(key, updateFn) {
    // Add to queue and return the result (not the queue itself!)
    const resultPromise = this.queue.then(async () => {
      if (!this.initialized) {
        throw new Error('[StorageManager] Not initialized! Call initialize() first.');
      }

      // Read the freshest value for this key from remote storage first.
      // This protects against races where another context may have updated
      // the key outside of this context's cache.
      const remoteObj = await chrome.storage.local.get(key);
      const currentValue = (remoteObj && remoteObj.hasOwnProperty(key))
        ? remoteObj[key]
        : this.cache[key];

      // Apply update function to the freshest value
      const newValue = await updateFn(currentValue);

      // Save to storage (use internal method which now merges with remote)
      await this._setInternal({ [key]: newValue });

      console.log('[StorageManager] UPDATE:', key, '→', newValue);
      return newValue;
    });
    
    // Update queue for next operation
    this.queue = resultPromise;
    
    // Return the result (not the queue!)
    return resultPromise;
  }

  /**
   * Add item to a Set stored as array
   * @param {string} key - Storage key
   * @param {*} item - Item to add
   * @returns {Promise<void>}
   */
  async addToSet(key, item) {
    return this.update(key, (currentArray = []) => {
      const set = new Set(currentArray);
      set.add(item);
      return Array.from(set);
    }).catch(error => {
      console.error(`[StorageManager] addToSet ERROR for key ${key}:`, error);
      throw error;
    });
  }

  /**
   * Remove item from a Set stored as array
   * @param {string} key - Storage key
   * @param {*} item - Item to remove
   * @returns {Promise<void>}
   */
  async removeFromSet(key, item) {
    return this.update(key, (currentArray = []) => {
      const set = new Set(currentArray);
      set.delete(item);
      return Array.from(set);
    }).catch(error => {
      console.error(`[StorageManager] removeFromSet ERROR for key ${key}:`, error);
      throw error;
    });
  }

  /**
   * Move item between two Sets - ATOMIC OPERATION
   * @param {string} fromKey - Source set key
   * @param {string} toKey - Destination set key
   * @param {*} item - Item to move
   * @returns {Promise<void>}
   */
  async moveToSet(fromKey, toKey, item) {
    const resultPromise = this.queue.then(async () => {
      try {
        // Read latest arrays from remote storage once to avoid operating on stale cache
        const remote = await chrome.storage.local.get([fromKey, toKey]);
        const fromArray = (remote && remote[fromKey]) ? remote[fromKey] : (this.cache[fromKey] || []);
        const toArray = (remote && remote[toKey]) ? remote[toKey] : (this.cache[toKey] || []);

        // Create sets and perform move
        const fromSet = new Set(fromArray);
        const toSet = new Set(toArray);

        fromSet.delete(item);
        toSet.add(item);

        // We already fetched the freshest remote slices; call internal setter
        // but skip the internal remote-read (we already have fresh data).
        await this._setInternal({
          [fromKey]: Array.from(fromSet),
          [toKey]: Array.from(toSet)
        }, { skipRemoteRead: true });

        console.log('[StorageManager] MOVE (based on remote):', item, 'from', fromKey, 'to', toKey);
      } catch (error) {
        console.error('[StorageManager] MOVE ERROR:', error);
        throw error;
      }
    }).catch(error => {
      console.error('[StorageManager] Queue error in moveToSet:', error);
      throw error;
    });
    
    this.queue = resultPromise.catch(() => Promise.resolve()); // Prevent queue blocking on error
    return resultPromise;
  }

  /**
   * Get cached value synchronously (use with caution!)
   * @param {string} key - Key to retrieve
   * @returns {*} Cached value or undefined
   */
  getCached(key) {
    if (!this.initialized) {
      console.warn('[StorageManager] Getting cache before initialization!');
      return undefined;
    }
    return this.cache[key];
  }

  /**
   * Listen for storage changes from other contexts
   * @param {Function} callback - Called when storage changes
   */
  onChanged(callback) {
    chrome.storage.onChanged.addListener((changes, areaName) => {
      if (areaName === 'local') {
        // Update cache
        for (const [key, { newValue }] of Object.entries(changes)) {
          if (this.cache) {
            this.cache[key] = newValue;
          }
        }
        
        console.log('[StorageManager] External change detected:', Object.keys(changes));
        callback(changes);
      }
    });
  }

  /**
   * Clear all storage (use with caution!)
   */
  async clear() {
    const resultPromise = this.queue.then(async () => {
      await chrome.storage.local.clear();
      this.cache = {};
      console.log('[StorageManager] Cleared all storage');
    });
    
    this.queue = resultPromise;
    return resultPromise;
  }

  /**
   * Export current state for debugging
   */
  async export() {
    const resultPromise = this.queue.then(async () => {
      return { ...this.cache };
    });
    
    this.queue = resultPromise;
    return resultPromise;
  }
}

// Create singleton instance (only if not already exists)
// Use globalThis so this module can be loaded both in window (content scripts)
// and in service worker/global (background) contexts.
if (!globalThis.storageManager) {
  globalThis.storageManager = new StorageManager();
}

// Export for use in other modules
if (typeof module !== 'undefined' && module.exports) {
  module.exports = StorageManager;
}
