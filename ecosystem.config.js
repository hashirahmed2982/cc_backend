module.exports = {
apps: [{
name: 'cardcove-api',
script: './server.js',
instances: 1,
watch: false,
max_memory_restart: '400M',
env_production: {
NODE_ENV: 'production',
},
}],
};
