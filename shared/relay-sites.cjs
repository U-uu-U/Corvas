const SITES = Object.freeze({
    ai: { name: '生图站', origin: 'https://ai.ravenhash.org', loginPath: '/sign-in', homePath: '/dashboard', logsPath: '/usage-logs', icon: 'image' },
    art: { name: '视频站', origin: 'https://art.ravenhash.org', loginPath: '/login', homePath: '/dashboard', logsPath: '/task-logs', icon: 'video' },
    cart: { name: '企业站', origin: 'https://cart.ravenhash.org', loginPath: '/login', homePath: '/dashboard', logsPath: '/task-logs', icon: 'grid' }
});
module.exports = { SITES };
