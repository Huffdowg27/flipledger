module.exports = {
  apps: [
    {
      name: 'flipledger',
      script: 'npm',
      args: 'start',
      cwd: '/Users/jamiehuff/flipledger',
      env: {
        PORT: 3002,
        NODE_ENV: 'production',
      },
    },
  ],
};
