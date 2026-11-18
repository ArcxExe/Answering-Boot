package com.arcx.answeringbot.bot;

import com.arcx.answeringbot.config.BotProperties;
import org.springframework.ai.chat.messages.AssistantMessage;
import org.springframework.ai.chat.messages.Message;
import org.springframework.ai.chat.messages.SystemMessage;
import org.springframework.ai.chat.messages.UserMessage;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.stereotype.Component;

import java.time.Clock;
import java.time.Instant;
import java.util.ArrayList;
import java.util.Collections;
import java.util.HashSet;
import java.util.Iterator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;

/**
 * Bounded in-memory reply-branch cache with TTL eviction that reconstructs
 * Spring AI prompt history along the reply chain from root to leaf.
 */
@Component
public class BranchContextStore {

    private final BotProperties properties;
    private final Clock clock;
    private final Map<MessageKey, BranchNode> cache = new LinkedHashMap<>(256, 0.75f, true);

    @Autowired
    public BranchContextStore(BotProperties properties) {
        this(properties, Clock.systemUTC());
    }

    BranchContextStore(BotProperties properties, Clock clock) {
        this.properties = properties;
        this.clock = clock;
    }

    public synchronized void recordNode(BranchNode node) {
        evictExpired();
        cache.put(node.key(), node);
        evictOverflow();
    }

    public synchronized boolean contains(MessageKey key) {
        evictExpired();
        return cache.containsKey(key);
    }

    public synchronized List<Message> buildPromptMessages(MessageKey leafKey) {
        evictExpired();

        List<BranchNode> chain = new ArrayList<>();
        Set<Integer> visitedIds = new HashSet<>();
        MessageKey cursor = leafKey;
        int maxDepth = properties.branchMaxDepth();

        while (cursor != null && chain.size() < maxDepth && visitedIds.add(cursor.messageId())) {
            BranchNode node = cache.get(cursor);
            if (node == null) {
                break;
            }
            chain.add(node);
            cursor = node.parentMessageId() != null
                    ? new MessageKey(cursor.chatId(), node.parentMessageId())
                    : null;
        }

        Collections.reverse(chain);

        List<Message> messages = new ArrayList<>(chain.size() + 1);
        messages.add(new SystemMessage(properties.systemPrompt()));
        for (BranchNode node : chain) {
            messages.add(toSpringAiMessage(node));
        }
        return List.copyOf(messages);
    }

    private Message toSpringAiMessage(BranchNode node) {
        if (node.role() == BranchNode.Role.ASSISTANT) {
            return new AssistantMessage(node.text());
        }
        return new UserMessage(formatUserContent(node));
    }

    private String formatUserContent(BranchNode node) {
        var sb = new StringBuilder();
        boolean hasPrefix = false;

        if (node.forwardedFrom() != null && !node.forwardedFrom().isBlank()) {
            sb.append("[Переслано от ").append(node.forwardedFrom()).append("]");
            hasPrefix = true;
        } else if (node.authorLabel() != null && !node.authorLabel().isBlank()) {
            sb.append(node.authorLabel());
            hasPrefix = true;
        }

        if (hasPrefix) {
            sb.append(": ");
        }
        sb.append(node.text());
        return sb.toString();
    }

    private void evictExpired() {
        Instant cutoff = clock.instant().minus(properties.branchCacheTtl());
        Iterator<Map.Entry<MessageKey, BranchNode>> iterator = cache.entrySet().iterator();
        while (iterator.hasNext()) {
            BranchNode node = iterator.next().getValue();
            if (node.createdAt().isBefore(cutoff)) {
                iterator.remove();
            }
        }
    }

    private void evictOverflow() {
        int maxSize = properties.branchCacheMaxSize();
        Iterator<Map.Entry<MessageKey, BranchNode>> iterator = cache.entrySet().iterator();
        while (cache.size() > maxSize && iterator.hasNext()) {
            iterator.next();
            iterator.remove();
        }
    }
}
