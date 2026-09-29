import { describeGenerationHealth } from '../shared/model-generation-health.mjs';

export function appendGenerationHealth(parent, metric) {
    const summary = describeGenerationHealth(metric);
    const footer = document.createElement('div');
    footer.className = 'generation-health';
    footer.dataset.health = summary.state;
    footer.title = summary.title;
    footer.setAttribute('aria-label', `${summary.title}\n${summary.duration}`);
    const strip = document.createElement('span');
    strip.className = 'generation-health-strip';
    strip.setAttribute('aria-hidden', 'true');
    for (const state of summary.samples) {
        const segment = document.createElement('i');
        segment.dataset.state = state;
        strip.appendChild(segment);
    }
    const duration = document.createElement('span');
    duration.className = 'generation-health-duration';
    duration.textContent = summary.duration;
    footer.append(strip, duration);
    parent.classList.add('has-generation-health');
    parent.appendChild(footer);
    const expiresIn = Date.parse(metric?.validUntil) - Date.now();
    const timer = expiresIn > 0 && expiresIn <= 180000 ? setTimeout(() => {
        if (!footer.isConnected) return;
        footer.remove();
        appendGenerationHealth(parent, metric);
    }, expiresIn + 10) : null;
    return () => { if (timer) clearTimeout(timer); };
}
