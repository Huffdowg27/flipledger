export interface InitializeWithRetryOptions {
  attempts?: number;
  delayMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

export async function initializeDatabaseWithRetry(
  initialize: () => void,
  options: InitializeWithRetryOptions = {},
): Promise<void> {
  const attempts = Math.max(1, options.attempts ?? 30);
  const delayMs = Math.max(0, options.delayMs ?? 500);
  const sleep = options.sleep ?? ((ms) => (
    new Promise<void>((resolve) => setTimeout(resolve, ms))
  ));

  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      initialize();
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'SQLITE_BUSY' || attempt === attempts) throw error;
      console.warn(
        `[sync-worker] Database initialization busy; retrying `
          + `(${attempt}/${attempts})`,
      );
      await sleep(delayMs);
    }
  }
}
