const version = new URLSearchParams(window.location.search).get('version') || '';
document.getElementById('splashVersion').textContent = version ? `v${version}` : '';
