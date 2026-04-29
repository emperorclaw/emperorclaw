module.exports = {
  apps: [
    {
      name: "emperorclaw",
      script: "node_modules/next/dist/bin/next",
      args: "start",
      instances: 1, // Run a single instance in cluster mode (allows zero-downtime reload)
      exec_mode: "cluster",
      watch: false,
      max_memory_restart: "1G",
      env: {
        NODE_ENV: "production",
        PORT: 3000
      }
    }
  ]
};
