const ICONS = {
    hunyuan: 'hunyuan.png', tripo: 'tripo.ico', jimeng: 'jimeng.ico',
    rhino: 'rhino.ico', blender: 'blender.png'
};

export function creativeAppIcon(app) {
    const file = ICONS[app];
    return file ? `<img class="creative-app-logo" src="./icons/creative-apps/${file}" alt="" aria-hidden="true" draggable="false">` : '';
}
