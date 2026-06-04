module.exports = {
  apps: [
    {
      name: 'flipledger',
      script: 'npm',
      args: 'start',
      cwd: __dirname,
      env: {
        PORT: 3002,
        NODE_ENV: 'production',
        // Treat il:* import lots as infinite supply so known per-unit costs apply
        // to every unit sold (fixes import-snapshot COGS leakage). Excludes amzn.gr.* graded.
        FIFO_IL_INFINITE: 'true',
      },
    },
  ],
};
