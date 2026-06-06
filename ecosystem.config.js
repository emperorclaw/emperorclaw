module.exports = {
  apps: [
    {
      name: "emperorclaw",
      script: "npm",
      args: "start",
      instances: 1,
      exec_mode: "fork",
      watch: false,
      max_memory_restart: "1G",
      env: {
        NODE_ENV: "production",
        PORT: 3000
      }
    }
  ]
};
