/**
 * Reply-branch prompt formatting helpers and bounded in-memory LRU+TTL store.
 */

export const BranchRole = Object.freeze({
  USER: 'user',
  ASSISTANT: 'assistant',
});

export function makeNodeKey(chatId, messageId) {
  return `${chatId}:${messageId}`;
}

export function formatUserContent(node) {
  if (typeof node.forwardedFrom === 'string' && node.forwardedFrom.trim().length > 0) {
    return `[Переслано от ${node.forwardedFrom.trim()}]: ${node.text}`;
  }
  if (typeof node.authorLabel === 'string' && node.authorLabel.trim().length > 0) {
    return `${node.authorLabel.trim()}: ${node.text}`;
  }
  return node.text;
}

export function toLlmMessage(node) {
  if (node.role === BranchRole.ASSISTANT) {
    return { role: 'assistant', content: node.text };
  }
  return { role: 'user', content: formatUserContent(node) };
}

/**
 * Formats a leaf-to-root node chain into a root-to-leaf LLM prompt array,
 * keeping total history size within `maxContextChars` (always preserving the leaf message).
 */
export function buildPromptMessagesFromLeafToRoot(leafToRootNodes, systemPrompt, maxContextChars) {
  const kept = [];
  let totalChars = 0;

  for (const node of leafToRootNodes) {
    const message = toLlmMessage(node);
    const len = message.content.length;
    if (kept.length > 0 && maxContextChars > 0 && totalChars + len > maxContextChars) {
      break;
    }
    kept.push(message);
    totalChars += len;
  }

  kept.reverse();
  return [{ role: 'system', content: systemPrompt }, ...kept];
}

export class BranchContextStore {
  constructor(config, nowFn = () => Date.now()) {
    this.config = config;
    this.nowFn = nowFn;
    this.cache = new Map();
  }

  recordNode(node) {
    this.#evictExpired();
    const key = makeNodeKey(node.chatId, node.messageId);
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
    return this.cache.has(makeNodeKey(chatId, messageId));
  }

  buildPromptMessages(chatId, leafMessageId, systemPromptOverride) {
    this.#evictExpired();

    const leafToRoot = [];
    const visitedIds = new Set();
    let cursorId = leafMessageId;
    const maxDepth = this.config.branchMaxDepth;

    while (cursorId != null && leafToRoot.length < maxDepth && !visitedIds.has(cursorId)) {
      visitedIds.add(cursorId);
      const key = makeNodeKey(chatId, cursorId);
      const node = this.cache.get(key);
      if (!node) {
        break;
      }
      // Touch entry for LRU access order
      this.cache.delete(key);
      this.cache.set(key, node);

      leafToRoot.push(node);
      cursorId = node.parentMessageId;
    }

    const activeSystemPrompt =
      typeof systemPromptOverride === 'string' && systemPromptOverride.trim().length > 0
        ? systemPromptOverride.trim()
        : this.config.systemPrompt;

    return buildPromptMessagesFromLeafToRoot(
      leafToRoot,
      activeSystemPrompt,
      this.config.branchMaxContextChars
    );
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
