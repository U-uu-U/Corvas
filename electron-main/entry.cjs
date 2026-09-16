if (process.argv.includes('--corvas-hunyuan-worker')) require('./hunyuan-window-worker.cjs');
else require('./main.js');
