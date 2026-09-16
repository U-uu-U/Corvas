const { app } = require('electron');
const profile = process.env.FLOW_HUNYUAN_SMOKE_PROFILE;
if (!profile) throw new Error('Isolated Hunyuan smoke profile required');
app.setPath('userData', profile);
app.setPath('sessionData', profile);
Object.defineProperty(app, 'isPackaged', { value: true });
if (process.env.FLOW_HUNYUAN_SMOKE_LIVE !== '1') {
    app.on('session-created', session => {
        void session.protocol.handle('https', () => new Response(
            '<!doctype html><title>Hunyuan session fixture</title><h1>Independent account fixture</h1><a href="https://xui.ptlogin2.qq.com/" target="_blank">Login popup</a>',
            { headers: { 'content-type': 'text/html; charset=utf-8' } }
        ));
    });
}
require('../electron-main/main.js');
