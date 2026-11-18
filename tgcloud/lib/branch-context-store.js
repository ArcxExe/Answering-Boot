/**
 * Bounded in-memory LRU reply-branch cache with TTL eviction that reconstructs
 * LLM prompt history along the reply chain from root to leaf.
 */

export const BranchRole = Object.freeze({
  USER: 'user',
  ASSISTANT: 'assistant',
});

function makeKey(chatId, messageId) {
  return `${chatId}:${messageId}`;
}

function formatUserContent(node) {
  if (typeof node.forwardedFrom === 'string' && node.forwardedFrom.trim().length > 0) {
    return `[Переслано от ${node.forwardedFrom.trim()}]: ${node.text}`;
  }
  if (typeof node.authorLabel === 'string' && node.authorLabel.trim().length > 0) {
    return `${node.authorLabel.trim()}: ${node.text}`;
  }
  return node.text;
}

export class BranchContextStore {
  constructor(config, nowFn = () => Date.now()) {
    this.config = config;
    this.nowFn = nowFn;
    this.cache = new Map();
  }

  recordNode(node) {
    this.#evictExpired();
    const key = makeKey(node.chatId, node.messageId);
    const entry = {
      chatId: node.chatId,
      messageId: node.messageId,
      parentMessageId: node.parentMessageId ?? null,
      role: node.role,
      authorLabel: node.authorLabel ?? null,
      forwardedFrom: node.forwardedFrom ?? null,
      text: node.text,
      createdAt: typeof node.createdAt === 'number' ? node.createdAt : this.nowFn(),
    };

    // Refresh insertion order to preserve LRU semantics
    if (this.cache.has(key)) {
      this.cache.delete(key);
    }
    this.cache.set(key, entry);
    this.#evictOverflow();
  }

  contains(chatId, messageId) {
    this.#evictExpired();
    return this.cache.has(makeKey(chatId, messageId));
  }

  buildPromptMessages(chatId, leafMessageId) {
    this.#evictExpired();

    const chain = [];
    const visitedIds = new Set();
    let cursorId = leafMessageId;
    const maxDepth = this.config.branchMaxDepth;

    while (cursorId != null && chain.length < maxDepth && !visitedIds.has(cursorId)) {
      visitedIds.add(cursorId);
      const key = makeKey(chatId, cursorId);
      const node = this.cache.get(key);
      if (!node) {
        break;
      }
      // Touch entry for LRU access order
      this.cache.delete(key);
      this.cache.set(key, node);

      chain.push(node);
      cursorId = node.parentMessageId;
    }

    chain.reverse();

    const messages = [{ role: 'system', content: this.config.systemPrompt }];
    for (const node of chain) {
      if (node.role === BranchRole.ASSISTANT) {
        messages.push({ role: 'assistant', content: node.text });
      } else {
        messages.push({ role: 'user', content: formatUserContent(node) });
      }
    }
    return messages;
  }

  #evictExpired() {
    const cutoff = this.nowFn() - this.config.branchCacheTtlMs;
    for (const [key, node] of this.cache) {
      if (node.createdAt < cutoff) {
        this.cache.delete(key);
      }
    }
  }

  #evictOverflow() {
    const maxSize = this.config.branchCacheMaxSize;
    while (this.cache.size > maxSize) {
      const oldestKey = this.cache.keys().next().value;
      this.cache.delete(oldestKey);
    }
  }
}
