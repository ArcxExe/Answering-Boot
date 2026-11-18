/**
 * Sends prompts to OpenRouter first and immediately falls back to Gemini on errors or blank replies.
 */
export function createLlmFallbackService({ primaryClient, fallbackClient, logger = console }) {
  return {
    async generateAnswer(messages) {
      if (!Array.isArray(messages) || messages.length === 0) {
        throw new Error('Messages list must not be empty');
      }

      try {
        const primaryAnswer = await primaryClient.ask(messages);
        if (typeof primaryAnswer === 'string' && primaryAnswer.trim().length > 0) {
          return primaryAnswer.trim();
        }
        logger.warn(
          'Primary LLM (OpenRouter) returned empty response, switching to Gemini fallback'
        );
      } catch (err) {
        const detail = err instanceof Error ? err.message : String(err);
        logger.warn(`Primary LLM (OpenRouter) failed (${detail}), switching to Gemini fallback`);
      }

      try {
        const fallbackAnswer = await fallbackClient.ask(messages);
        if (typeof fallbackAnswer === 'string' && fallbackAnswer.trim().length > 0) {
          return fallbackAnswer.trim();
        }
        throw new Error('Fallback LLM (Gemini) returned empty response');
      } catch (err) {
        if (err instanceof Error && err.message === 'Fallback LLM (Gemini) returned empty response') {
          throw err;
        }
        const detail = err instanceof Error ? err.message : String(err);
        throw new Error(`Both OpenRouter and Gemini LLM providers failed: ${detail}`);
      }
    },
  };
}
