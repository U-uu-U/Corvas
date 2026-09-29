"""Publish the confirmed SD2 Fast image/audio reference capabilities only."""
import json
import runpy
import shlex
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SOURCE = r'''
import assert from 'node:assert/strict';
import {createConfigStore} from '/srv/flow-config/lib/store.mjs';
import {createValidator} from '/srv/flow-config/lib/validate.mjs';
const store=createConfigStore({dataDir:'/var/lib/flow-config'});
const current=store.current();
const config=structuredClone(current.config);
const matches=config.models.filter(m=>m.catalog?.model==='sd2-fast');
assert.equal(matches.length,1,'SD2 Fast must resolve to one catalog entry');
const entry=matches[0];
const before=structuredClone(entry);
entry.capabilities.referenceVideos={supported:false,max:0,reason:'商家确认不支持视频参考，请使用参考图片或音频'};
entry.capabilities.referenceAudios={supported:true,max:3,reason:'商家确认支持最多3段音频参考'};
entry.parameters.accepts=[...new Set(entry.parameters.accepts.filter(k=>k!=='video_urls').concat('audio_urls'))];
entry.notes='2026-09-29商家确认：最多9张图片、3段音频参考，不支持视频参考；480p最多15秒、720p最多12秒；不限制人脸；按次计费';
for(const rule of entry.parameterRules?.rules||[]) {
    if(rule.capabilities?.referenceVideos) rule.capabilities.referenceVideos=structuredClone(entry.capabilities.referenceVideos);
    if(rule.capabilities?.referenceAudios) rule.capabilities.referenceAudios=structuredClone(entry.capabilities.referenceAudios);
}
const validation=(await createValidator({schemaPath:'/srv/flow-config/schema/model-config.schema.json'})).validate(config);
assert.equal(validation.ok,true,JSON.stringify(validation.errors));
assert.deepEqual(config.models.filter(m=>m.id!==entry.id),current.config.models.filter(m=>m.id!==entry.id));
assert.deepEqual(entry.catalog,before.catalog);assert.deepEqual(entry.pricing,before.pricing);assert.deepEqual(entry.options,before.options);
assert.equal(store.current().config.revision,current.config.revision,'Catalog changed during validation');
const changed=JSON.stringify(before)!==JSON.stringify(entry);
const result=changed?store.save(config,{actor:'codex',note:'按用户确认修正SD2 Fast音频上限为3段，保留9图、不支持视频'}):current;
console.log(JSON.stringify({changed,revision:result.revision??result.config.revision,id:entry.id,
    before:{capabilities:before.capabilities,accepts:before.parameters.accepts},
    after:{capabilities:entry.capabilities,accepts:entry.parameters.accepts}}));
'''

if __name__ == '__main__':
    control = runpy.run_path(str(ROOT / 'scripts/config-channel-control.py'))
    client = control['connect']()
    try:
        command = 'runuser -u flowconfig -- /srv/flow-config/runtime/node --input-type=module -e ' + shlex.quote(SOURCE)
        _, out, err = client.exec_command(command, timeout=25)
        data = out.read().decode('utf-8')
        error = err.read().decode('utf-8')
        if out.channel.recv_exit_status(): raise RuntimeError(error)
        result = json.loads(data)
        result['canvas'] = control['refresh_canvas']('stable', 'http://127.0.0.1:18765')
        (ROOT / 'output/sd2-fast-reference-correction.json').write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding='utf-8')
        print(json.dumps(result, ensure_ascii=True))
    finally:
        client.close()
