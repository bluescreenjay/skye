// Errors shared by every AI feature. Their messages are stored on records and
// returned to clients, so they are fixed and generic: never prompt text, tab
// content, or the vendor's response body.

/** The AI service failed: timeout, HTTP error, network error, or an unusable answer. */
export class ModelError extends Error {
  constructor(message = "The AI service could not complete the request.") {
    super(message);
    this.name = "ModelError";
  }
}

/** No model key is configured on the server. */
export class ModelUnconfiguredError extends Error {
  constructor(message = "No AI model key is configured on the server.") {
    super(message);
    this.name = "ModelUnconfiguredError";
  }
}

/** The daily AI-call budget is spent, or the vendor said its quota is used up. Never retried. */
export class BudgetExceededError extends Error {
  constructor(message = "The daily AI request budget has been reached. Try again later.") {
    super(message);
    this.name = "BudgetExceededError";
  }
}
