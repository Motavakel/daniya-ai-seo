export class LighthouseExecutionError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'LighthouseExecutionError';
  }
}
