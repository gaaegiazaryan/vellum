/**
 * Domain errors for the extraction pipeline. Each carries enough
 * context for the caller to log, retry, or surface a meaningful
 * message to the user.
 */
export class ExtractionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

export class UnreadableImageError extends ExtractionError {
  constructor(
    readonly mimeType: string,
    readonly reason: string,
  ) {
    super(`unreadable image (${mimeType}): ${reason}`);
  }
}

export class ProviderTimeoutError extends ExtractionError {
  constructor(
    readonly provider: string,
    readonly timeoutMs: number,
  ) {
    super(`provider ${provider} did not respond within ${timeoutMs}ms`);
  }
}

export class InvalidProviderResponseError extends ExtractionError {
  constructor(
    readonly provider: string,
    readonly detail: string,
  ) {
    super(`provider ${provider} returned an invalid response: ${detail}`);
  }
}

export class BudgetExceededError extends ExtractionError {
  constructor(
    readonly limitUsd: string,
    readonly accumulatedUsd: string,
  ) {
    super(`extraction budget exceeded: ${accumulatedUsd} / ${limitUsd}`);
  }
}
