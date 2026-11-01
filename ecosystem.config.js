module.exports = {
  apps: [{
    name: 'khatym-bot',
    script: 'main.js',
    
    // Crash болғанда автоматты restart
    autorestart: true,
    
    // Restart арасында 10 секунд кідіру (тым жиі restart болмау үшін)
    restart_delay: 10000,
    
    // 15 минутта 10-нан артық restart болса — тоқтату
    max_restarts: 10,
    min_uptime: '60s',
    
    // Жады лимиті: 1GB-тан асса restart
    max_memory_restart: '1G',
    
    // Логтар
    error_file: './logs/error.log',
    out_file: './logs/out.log',
    merge_logs: true,
    
    // Уақыт белгісі
    time: true,
    
    // Node.js environment
    env: {
      NODE_ENV: 'production'
    }
  }]
};
