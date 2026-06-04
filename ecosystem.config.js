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
      },
    },
  ],
};
