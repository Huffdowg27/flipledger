module.exports = {
  apps: [
    {
      name: 'flipledger',
      script: 'npm',
      // Bind to loopback only. The app has no auth and /api/data/settings can
      // expose credentials — it must not listen on 0.0.0.0. The hostname flag
      // lives in the `start` script itself so a bare `npm start` (VPS, systemd,
      // manual run) is loopback-bound too. PORT comes from env below.
      args: 'start',
      cwd: __dirname,
      env: {
        PORT: 3002,
        NODE_ENV: 'production',
        TZ: 'America/Los_Angeles',
        FLIPLEDGER_START_AUTOSYNC_ON_BOOT: 'false',
        FLIPLEDGER_AUTOSYNC_CONTROL: 'external',
        // Treat il:* import lots as infinite supply so known per-unit costs apply
        // to every unit sold (fixes import-snapshot COGS leakage). Excludes amzn.gr.* graded.
        FIFO_IL_INFINITE: 'true',
      },
    },
    {
      name: 'flipledger-sync',
      script: 'src/sync-worker.ts',
      interpreter: 'node',
      node_args: '--import tsx',
      cwd: __dirname,
      kill_timeout: 10 * 60 * 1000,
      env: {
        NODE_ENV: 'production',
        TZ: 'America/Los_Angeles',
        FIFO_IL_INFINITE: 'true',
      },
    },
  ],
};
