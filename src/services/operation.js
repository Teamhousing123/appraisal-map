export const OPERATION_ERROR_CODES = Object.freeze({
  ABORTED: 'ABORTED',
  TIMEOUT: 'TIMEOUT',
  FAILED: 'FAILED',
});

export class OperationError extends Error {
  constructor(message, { code = OPERATION_ERROR_CODES.FAILED, cause, retryable = false } = {}) {
    super(message);
    this.name = 'OperationError';
    this.code = code;
    this.retryable = retryable;
    if (cause !== undefined) this.cause = cause;
  }
}

export function isAbortError(error) {
  return error?.name === 'AbortError'
    || error?.code === OPERATION_ERROR_CODES.ABORTED;
}

function abortError(label, cause) {
  return new OperationError(`${label} was cancelled.`, {
    code: OPERATION_ERROR_CODES.ABORTED,
    cause,
    retryable: false,
  });
}

function timeoutError(label, timeoutMs) {
  return new OperationError(`${label} took too long. Check your connection and try again.`, {
    code: OPERATION_ERROR_CODES.TIMEOUT,
    retryable: true,
    cause: new Error(`Timed out after ${timeoutMs} ms`),
  });
}

function wait(delayMs, signal) {
  if (delayMs <= 0) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const finish = () => {
      signal?.removeEventListener('abort', handleAbort);
      resolve();
    };
    const timer = setTimeout(finish, delayMs);
    const handleAbort = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', handleAbort);
      reject(abortError('Request', signal.reason));
    };
    if (signal) {
      if (signal.aborted) {
        handleAbort();
        return;
      }
      signal.addEventListener('abort', handleAbort, { once: true });
    }
  });
}

async function runAttempt(operation, { attempt, timeoutMs, signal, label }) {
  if (signal?.aborted) throw abortError(label, signal.reason);

  const controller = new AbortController();
  const relayAbort = () => controller.abort(signal?.reason);
  signal?.addEventListener('abort', relayAbort, { once: true });

  let timer;
  const timeout = new Promise((_resolve, reject) => {
    timer = setTimeout(() => {
      const error = timeoutError(label, timeoutMs);
      reject(error);
      controller.abort(error);
    }, timeoutMs);
  });

  try {
    return await Promise.race([
      Promise.resolve().then(() => operation({ attempt, signal: controller.signal })),
      timeout,
    ]);
  } catch (error) {
    if (signal?.aborted) throw abortError(label, error);
    if (error?.name === 'AbortError' && !controller.signal.aborted) {
      throw abortError(label, error);
    }
    throw error;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', relayAbort);
  }
}

export async function runBoundedOperation(
  operation,
  {
    label = 'Request',
    timeoutMs = 15000,
    retries = 0,
    retryDelayMs = 250,
    shouldRetry = (error) => Boolean(error?.retryable),
    signal,
  } = {}
) {
  if (typeof operation !== 'function') throw new TypeError('An operation function is required.');
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new TypeError('timeoutMs must be a positive number.');
  }
  const retryCount = Number.isInteger(retries) && retries > 0 ? Math.min(retries, 3) : 0;

  let lastError;
  for (let attempt = 0; attempt <= retryCount; attempt += 1) {
    try {
      return await runAttempt(operation, { attempt, timeoutMs, signal, label });
    } catch (error) {
      lastError = error;
      if (isAbortError(error) || attempt >= retryCount || !shouldRetry(error, attempt)) throw error;
      await wait(retryDelayMs * (attempt + 1), signal);
    }
  }
  throw lastError;
}
