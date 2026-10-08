"""Publish current public video contracts into the existing art/cart docs plugin."""
import argparse
import datetime
import hashlib
import json
from pathlib import Path
import runpy
import shlex
import urllib.request
import uuid

ROOT = Path(__file__).resolve().parents[1]
HELPER = runpy.run_path(str(ROOT / 'scripts/deploy-release-page.py'))
OUT = ROOT / 'output' / 'current-api-docs'
PREFIX = 'corvas-current-'


def sql(client, site, query):
    container = 'tokensbyte-postgres' if site == 'art' else 'tkeapi-postgres'
    temporary = None
    source = repr(query)
    if len(query.encode('utf-8')) > 16000:
        temporary = '/tmp/corvas-api-docs-' + uuid.uuid4().hex + '.sql'
        sftp = client.open_sftp()
        try:
            with sftp.file(temporary, 'w') as remote:
                remote.write(query)
            sftp.chmod(temporary, 0o600)
        finally:
            sftp.close()
        source = "open(" + repr(temporary) + ",encoding='utf-8').read()"
    code = '''import json,subprocess
p=CONTAINER
e=dict(v.split('=',1) for v in json.loads(subprocess.check_output(['docker','inspect',p],text=True))[0]['Config']['Env'] if '=' in v)
cmd=['docker','exec','-i',p,'psql','-X','-qAt','-U',e.get('POSTGRES_USER','postgres'),'-d',e.get('POSTGRES_DB',e.get('POSTGRES_USER','postgres')),'-v','ON_ERROR_STOP=1']
print(subprocess.check_output(cmd,input=QUERY,text=True),end='')
'''.replace('CONTAINER', repr(container)).replace('QUERY', source)
    try:
        return HELPER['run'](client, 'python3 -c ' + shlex.quote(code), timeout=60)
    finally:
        if temporary:
            sftp = client.open_sftp()
            try:
                sftp.remove(temporary)
            finally:
                sftp.close()


def literal(value):
    if value is None:
        return 'NULL'
    return "'" + str(value).replace("'", "''") + "'"


def fetch(url):
    with urllib.request.urlopen(url, timeout=30) as response:
        return json.load(response)


def json_block(value):
    return '```json\n' + json.dumps(value, ensure_ascii=False, indent=2) + '\n```'


def resolution_values(model):
    option = model.get('options', {}).get('resolutionTier', {})
    return option.get('values') or [option.get('value', '720p')]


def reference_limit(model, key):
    cap = model.get('capabilities', {}).get(key, {})
    if not cap.get('supported', False):
        return '不支持'
    return f"最多 {cap['max']} 个" if 'max' in cap else '支持；数量上限未在当前目录明确，请以接口校验为准'


def family(model_id):
    if model_id == 'minimax-h3':
        return 'minimax'
    if model_id.startswith(('ch0107-', 'ch1401-')):
        return 'backup'
    if model_id.startswith('artsdance'):
        return 'arts'
    return 'seedance'


def example(model, references=False):
    name = model['catalog']['model']
    kind = family(name)
    res = resolution_values(model)[0]
    prompt = '镜头缓慢推进，主体自然走动，光影连贯，保持人物与场景一致。'
    if kind == 'minimax':
        body = dict(model=name, prompt=prompt, duration=4, resolution='2k', aspect_ratio='16:9')
        if references:
            body.update(first_image='https://example.com/reference.png')
    elif kind == 'backup':
        body = dict(model=name, client_task_id='replace-with-a-new-uuid', prompt=prompt,
                    mode='references', duration=4, resolution='720p', aspect_ratio='16:9')
        if references:
            body['references'] = {'image': 'https://example.com/reference.png'}
            if name.startswith('ch0107-'):
                body['references'].update(video='https://example.com/motion.mp4',
                                          audio='https://example.com/voice.mp3')
    elif kind == 'arts':
        body = dict(model=name, prompt=prompt, duration=5, resolution='720p', ratio='16:9', generate_audio=True)
        if references:
            body.update(images=[{'url': 'https://example.com/reference.png', 'role': 'reference_image'}],
                        videos=['https://example.com/motion.mp4'], audios=['https://example.com/voice.mp3'])
    else:
        body = dict(model=name, prompt=prompt, seconds=4, resolution=res, ratio='16:9')
        if references:
            body['image_urls'] = ['https://example.com/reference.png']
            caps = model.get('capabilities', {})
            if caps.get('referenceVideos', {}).get('supported'):
                body['video_urls'] = ['https://example.com/motion.mp4']
            if caps.get('referenceAudios', {}).get('supported'):
                body['audio_urls'] = ['https://example.com/voice.mp3']
    return body


def sale_price(row):
    if row['billing_type'] in ('fixed', 'requests') and float(row.get('fixed_rate') or 0) > 0:
        return f"{float(row['fixed_rate']):.2f} 元/次"
    if row['billing_type'] == 'duration' and float(row.get('duration_rate') or 0) > 0:
        return f"{float(row['duration_rate']):.2f} 元/秒"
    if row['billing_type'] == 'duration':
        return '按分辨率与生成时长计费'
    return '按视频 Token 计费（详见站点价格页）'


def model_content(model, row, site, revision):
    name = model['catalog']['model']
    kind = family(name)
    opt = model.get('options', {})
    dur = opt['duration']
    ratios = [v for v in opt.get('ratio', {}).get('values', []) if v != 'adaptive']
    title = row.get('name') or model['label']
    text = f'''# {title}

更新时间：2026-10-06；参数目录：r{revision}。此页使用本平台公开模型名。

## 接口与模型名

- Base URL：`https://{site}.ravenhash.org`
- 提交：`POST /v1/video/generations`
- 查询：`GET /v1/video/generations/{{task_id}}`
- 鉴权：`Authorization: Bearer YOUR_API_KEY`；请求格式：`Content-Type: application/json`
- `model` 必须完整填写：`{name}`，保留大小写、连字符和下划线。
- 当前标准售价：{sale_price(row)}，人民币计费；账户分组或优惠可能影响最终扣费，以站点价格页和账单为准。

## 参数范围

| 参数 | 范围或要求 |
| --- | --- |
| `model` | 必填，使用上面的完整模型名 |
| `prompt` | 必填，非空文本；描述主体、动作、镜头、场景和声音要求 |
| 视频时长 | {dur['min']}～{dur['max']} 秒，整数；建议显式填写 |
| 分辨率 | {'、'.join(resolution_values(model))} |
| 画面比例 | {'、'.join(ratios)} |
| 图片参考 | {reference_limit(model, 'referenceImages')} |
| 视频参考 | {reference_limit(model, 'referenceVideos')} |
| 音频参考 | {reference_limit(model, 'referenceAudios')} |

“自适应”是画布的处理选项。直接调用 API 时请填写上述具体画面比例。

'''
    if kind == 'seedance':
        text += '''## 请求字段

使用 `seconds`（整数秒）、`ratio`、`resolution`。图片是 `image_urls` 字符串数组；支持视频或音频参考的型号分别使用 `video_urls`、`audio_urls` 字符串数组。不要把其他线路的 `references` 或 `audios` 格式直接套用到本型号。

参考图按数组顺序引用。提示词中的本地文件名不会自动上传或绑定；请描述“参考图1/参考图2”的用途，并将素材 URL 放进数组。音频参考不代表保证声音克隆，具体效果取决于模型。

'''
        if name.startswith('LongXia-'):
            text += '单张参考图片不超过 20 MiB；音频使用 MP3，每段不超过 15 MiB。分辨率由模型固定，不能通过参数改为其他档位。\n\n'
        elif name.startswith('seedance-2.5-'):
            text += '单张参考图片不超过 20 MiB；音频支持 MP3/WAV，每段不超过 20 MiB。分辨率由模型固定，不能通过参数改为其他档位。\n\n'
    elif kind == 'backup':
        text += '''## 请求字段

`client_task_id` 是本次提交的业务唯一标识，请生成新的 UUID 并与任务一起保存。它不替代接口返回的任务 ID；此字段不构成超时后重复 POST 的安全保证。

`mode` 固定为 `references`。时长使用 `duration`，比例使用 `aspect_ratio`。没有参考素材时省略 `references`，不要提交空对象。

`references` 内一张图片使用 `image`（字符串），多张使用 `images`（字符串数组）；视频为 `video`/`videos`，音频为 `audio`/`audios`。同一种素材只使用单数或复数中的一种。字段是否可用及数量以本页参数表为准。

'''
    elif kind == 'arts':
        text += '''## 请求字段

时长使用 `duration`，比例使用 `ratio`。图片参考使用 `images` 数组；支持字符串或 `{ "url": "...", "role": "reference_image" }` 对象。视频参考使用 `videos` 数组，音频参考使用 `audios` 数组（不是其他线路的 `audio_urls`）。

图片角色可填 `first_frame`、`last_frame`、`reference_image`。仅给 1 张无角色图片时按首帧处理，2 张按首尾帧处理；用于人物/外观参考时请显式设置 `role: reference_image`。

可选布尔字段：`camera_fixed`、`generate_audio`、`web_search`、`watermark`。目录声明的时长/分辨率范围仍需通过实际模型校验；不应把未明确的参考数量理解为无限制。示例使用 5 秒、720p。

'''
    else:
        text += '''## 请求字段

推荐使用 `duration`、`resolution`、`aspect_ratio`，平台会根据素材自动选择处理流程。

- 无素材：文生视频；普通分辨率对应 `text-to-video`。
- 1 张图：`first_image`；2 张图：`first_image` + `last_image`，按首尾帧生成。
- 多图：`reference_images` 字符串数组。
- 视频参考：`reference_videos` 字符串数组；音频参考：`reference_audios` 字符串数组。存在视频或音频时，使用多参考流程。
- `resolution` 使用 `480p`、`768p`、`1080p`、`2k`、`4k`；2k/4k 是超分流程，不代表基础生成分辨率。
- 进阶可显式传 `seconds`、`workflow_id`、`size`，不要与推荐字段传入相互矛盾的值。`workflow_id` 可为 `text-to-video`、`fl2v`、`multi-reference`、`cf-fl2v`、`cf-multi-reference`；超分的 `size` 使用 `2K`/`4K`。
- 提示词不超过 5000 字符。参考图片宽高均需在 256～5760 像素，宽高比在 0.4～2.5；视频参考不超过 50 MiB/个，音频参考不超过 15 MiB/个。

'''
    if model.get('capabilities', {}).get('face', {}).get('supported') is False:
        text += '本型号的人脸参考受限制，可能被拒绝；请遵循返回的素材校验提示。\n\n'
    text += '## 文生视频示例\n\n' + json_block(example(model))
    text += '\n\n## 参考素材示例\n\n下列 example.com 地址是占位符，请替换成可从公网直接下载的实际素材链接。\n\n' + json_block(example(model, True))
    text += '''

素材链接必须为 HTTP(S) 直链且在任务处理期间有效，不能是本地路径、需要登录的网页、Data URL 或素材管理页面。音频或视频不支持的型号请省略对应字段，不要发空数组或伪造参数。

## 提交、查询与下载

将上述 JSON 保存为 `request.json`，然后执行：

```bash
'''
    text += f'''export CORVAS_BASE_URL="https://{site}.ravenhash.org"
export CORVAS_API_KEY="YOUR_API_KEY"
curl --fail-with-body "$CORVAS_BASE_URL/v1/video/generations" \\
  -H "Authorization: Bearer $CORVAS_API_KEY" \\
  -H "Content-Type: application/json" \\
  --data-binary @request.json
```

保存响应中的 `id`（某些响应也含 `task_id`）。查询必须使用原站点与提交时的 Key：

```bash
curl --fail-with-body "$CORVAS_BASE_URL/v1/video/generations/TASK_ID" \\
  -H "Authorization: Bearer $CORVAS_API_KEY"
```

'''
    text += '''提交成功只表示任务已受理。`pending` / `processing` / `running` 表示排队或处理中，建议每 10～15 秒查询一次；`completed`（或原始状态 `succeeded`）表示生成完成，读取 `data[].url` 并下载；`failed` 表示失败，查看 `error.message`。

以下为统一格式示意，字段可能附带额外数据：

''' + json_block({'id': 'TASK_ID', 'object': 'video', 'status': 'pending'})
    text += '\n\n' + json_block({'id': 'TASK_ID', 'object': 'video', 'status': 'completed', 'data': [{'url': 'https://example.com/result.mp4'}]})
    text += '''

完成后有地址再进入下载步骤，不能把“任务完成”等同于“本地已经下载”。如完成状态暂未携带地址，继续查询原任务；不要创建新任务。下载返回的文件链接时，不要向站点外的文件服务器发送 API Key。文件链接可能过期，请及时保存；过期时先查询原任务。

## 失败与恢复

- 400 / 参数错误：按本页检查模型字段、时长、分辨率、素材格式和尺寸。
- 401 / 403：检查 Key 是否有效、是否属于此站点、是否有模型权限。
- 模型不存在或停用：先查询 `GET /v1/models`，确认当前账户可用模型与完整名称。
- 429：放慢查询频率；已受理任务仍查询原任务。
- 提交超时或 5xx：可能已受理，不要立即重复 POST。保留原响应、任务 ID、`client_task_id`（如有）、发生时间和排查编号，与管理员核对。
- 查询失败或下载失败不等于生成失败，也不表示已退款。计费结果以任务及账单记录为准。
- 向管理员提交排查编号、模型名、时间、任务 ID、状态码和脱敏请求。不要提交 API Key；不要把完整提示词或私有素材公开发布。

文档列出的是目录发布时的上架参数，不能保证每个渠道实时可用。运行时请同时查看站点模型可用状态与账户权限。
'''
    return text


def prepare(site):
    config = fetch('https://artconfig.ravenhash.org/config')
    host = site + '.ravenhash.org'
    models = [m for m in config['models'] if m.get('kind') == 'video'
              and host in m.get('catalog', {}).get('hosts', [])
              and m['catalog'].get('enabled') is True and m.get('presentation', {}).get('visible', True)]
    client = HELPER['connect'](site)
    try:
        docs = json.loads(sql(client, site, "SELECT coalesce(json_agg(x),'[]') FROM (SELECT * FROM plugin_docs ORDER BY id)x"))
        rows = json.loads(sql(client, site, "SELECT coalesce(json_agg(x),'[]') FROM (SELECT m.model_id,m.name,m.is_active,b.billing_type,b.fixed_rate,b.duration_rate FROM models m LEFT JOIN billing_rules b ON b.id=m.billing_rule_id WHERE m.is_active=1 ORDER BY m.sort_order,m.id)x"))
        plugin = json.loads(sql(client, site, "SELECT json_agg(x) FROM (SELECT id,name,is_enabled FROM plugins WHERE name='docs_api')x"))
        if not plugin or len(plugin) != 1:
            raise RuntimeError('Docs plugin is not uniquely identifiable')
    finally:
        client.close()
    by_name = {row['model_id']: row for row in rows}
    models = [m for m in models if m['catalog']['model'] in by_name]
    if not models:
        raise ValueError('No listed models found')
    directory = dict(slug=PREFIX + 'models', title='当前上架模型接口', is_dir=1, sort_order=5, content='')
    pages = []
    for index, model in enumerate(models):
        name = model['catalog']['model']
        title = by_name[name]['name']
        if name.startswith('artsdance'):
            title = model['label']
        elif name.startswith(('ch0107-', 'ch1401-')):
            title = 'Seedance 2.5 Pro 备用（' + ('满参' if name.startswith('ch0107-') else '卡人脸') + '）'
        pages.append(dict(slug=PREFIX + name.lower(), title=title, is_dir=0, sort_order=20 + index,
                          content=model_content(model, by_name[name], site, config['revision'])))
    index = f'''# 当前上架视频模型 API

本站 Base URL：`https://{host}`。更新日期：2026-10-06；目录版本：r{config['revision']}。

本目录覆盖当前画布已启用且可见、本站已启用的 {len(models)} 个视频模型。已下架或隐藏的渠道不列入此目录。模型名称、参数与参考素材格式详见左侧各型号页面；目录上架不等于实时可用，调用权限以当前账户为准。

所有视频采用异步流程：提交 → 保存任务 ID → 查询原任务 → 获得文件链接 → 下载保存。提交接口 `POST /v1/video/generations`，查询接口 `GET /v1/video/generations/{{task_id}}`，均使用本站 API Key 的 Bearer 鉴权。

## 模型与售价

两站均按人民币计费，本页价格属于本站标准售价，不是供应商成本。优惠或账户分组倍率以本站价格页与账单为准。

| 模型名（请求时完整填写） | 时长（秒） | 分辨率 | 本站标准售价 |
| --- | --- | --- | --- |
'''
    for m in models:
        name = m['catalog']['model']
        d = m['options']['duration']
        index += f"| `{name}` | {d['min']}～{d['max']} | {' / '.join(resolution_values(m))} | {sale_price(by_name[name])} |\n"
    index += '''
## 先选择对应参数格式

- HM / LongXia / Seedance 2.5 按次型号：`seconds`、`ratio`、`image_urls`，按型号能力加入 `video_urls` / `audio_urls`。
- `ch0107` / `ch1401` 备用型号：`duration`、`aspect_ratio`、`client_task_id`、`mode`、`references`。
- Seedance 2.0 Fast / Mini：`duration`、`ratio`、`images` / `videos` / `audios`；图片可显式指定 `role`。
- MiniMax H3：`duration`、`resolution`、`aspect_ratio`，首尾帧用 `first_image` / `last_image`，多参考用 `reference_images` / `reference_videos` / `reference_audios`。

不同型号不能只替换 `model` 后原样复用所有参数。每页提供完整 JSON 示例、素材限制、curl 提交与查询方式、错误和恢复步骤。

## 当前账户模型查询

```bash
'''
    index += f'''curl --fail-with-body "https://{host}/v1/models" \\
  -H "Authorization: Bearer $CORVAS_API_KEY"
```

新站和老站的 Key、余额和任务记录分别管理。查询任务必须回到提交任务的站点。
'''
    pages.insert(0, dict(slug=PREFIX + 'overview', title='接入总览与当前模型列表', is_dir=0, sort_order=10, content=index))
    # Existing entry URLs continue to work, with current contracts replacing stale examples.
    aliases = [d for d in docs if d.get('slug') in ('volc-video', 'video') and not d['is_dir']]
    manifest = dict(site=site, revision=config['revision'], preparedAt=datetime.datetime.now(datetime.timezone.utc).isoformat(),
                    modelCount=len(models), directory=directory, pages=pages, aliases=[dict(id=d['id'], slug=d['slug'], title=d['title']) for d in aliases],
                    baseline=docs, plugin=plugin[0])
    OUT.mkdir(parents=True, exist_ok=True)
    (OUT / f'{site}-plan.json').write_text(json.dumps(manifest, ensure_ascii=False, indent=2), encoding='utf-8')
    target = OUT / site
    target.mkdir(exist_ok=True)
    for p in pages:
        (target / (p['slug'] + '.md')).write_text(p['content'], encoding='utf-8')
    print(json.dumps(dict(site=site, revision=config['revision'], models=len(models), pages=len(pages), legacyEntries=len(aliases)), ensure_ascii=False))


def deploy(site):
    plan = json.loads((OUT / f'{site}-plan.json').read_text(encoding='utf-8'))
    if fetch('https://artconfig.ravenhash.org/config')['revision'] != plan['revision']:
        raise RuntimeError('Catalog changed; prepare again')
    client = HELPER['connect'](site)
    try:
        current = json.loads(sql(client, site, "SELECT coalesce(json_agg(x),'[]') FROM (SELECT * FROM plugin_docs ORDER BY id)x"))
        if current != plan['baseline']:
            raise RuntimeError('Docs changed since preparation; prepare again')
        stamp = datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%SZ')
        backup = f'/var/backups/corvas-api-docs-{stamp}.json'
        sftp = client.open_sftp()
        try:
            with sftp.file(backup, 'w') as f:
                f.write(json.dumps(dict(documents=current, plugin=plan['plugin']), ensure_ascii=False))
            sftp.chmod(backup, 0o600)
        finally:
            sftp.close()
        statements = ["BEGIN; SET LOCAL lock_timeout='5s'; SET LOCAL statement_timeout='30s'; LOCK TABLE plugin_docs IN SHARE ROW EXCLUSIVE MODE;"]
        # The locked check closes the race between snapshot verification and publication.
        baseline = json.dumps(current, ensure_ascii=False)
        statements.append("DO $guard$ BEGIN IF (SELECT coalesce(json_agg(x),'[]')::jsonb FROM (SELECT * FROM plugin_docs ORDER BY id)x) <> " + literal(baseline) + "::jsonb THEN RAISE EXCEPTION 'Docs changed during publication'; END IF; END $guard$;")
        plugin = plan['plugin']
        statements.append(f"DO $plugin$ BEGIN IF (SELECT is_enabled FROM plugins WHERE id={plugin['id']} AND name='docs_api') IS DISTINCT FROM {plugin['is_enabled']} THEN RAISE EXCEPTION 'Docs plugin state changed'; END IF; END $plugin$;")
        statements.append(f"UPDATE plugins SET is_enabled=1 WHERE id={plugin['id']} AND name='docs_api';")
        def upsert(page, parent):
            values = f"{literal(page['title'])},{literal(page['content'])},{page['is_dir']},{page['sort_order']},1,{literal(page['slug'])},{parent}"
            statements.append("UPDATE plugin_docs SET title=" + literal(page['title']) + ",content=" + literal(page['content']) + f",is_dir={page['is_dir']},sort_order={page['sort_order']},is_active=1,parent_id={parent},updated_at=now() WHERE slug=" + literal(page['slug']) + ';')
            statements.append('INSERT INTO plugin_docs(title,content,is_dir,sort_order,is_active,slug,parent_id,created_at,updated_at) SELECT ' + values + ',now(),now() WHERE NOT EXISTS(SELECT 1 FROM plugin_docs WHERE slug=' + literal(page['slug']) + ');')
        upsert(plan['directory'], 'NULL')
        parent = '(SELECT id FROM plugin_docs WHERE slug=' + literal(plan['directory']['slug']) + ')'
        for page in plan['pages']:
            upsert(page, parent)
        for alias in plan['aliases']:
            statements.append('UPDATE plugin_docs SET content=' + literal(plan['pages'][0]['content']) + ',updated_at=now() WHERE id=' + str(alias['id']) + ';')
        statements.append('COMMIT;')
        sql(client, site, '\n'.join(statements))
        after = json.loads(sql(client, site, "SELECT coalesce(json_agg(x),'[]') FROM (SELECT * FROM plugin_docs ORDER BY id)x"))
        changed_ids = {a['id'] for a in plan['aliases']}
        before_unrelated = [d for d in current if not (d.get('slug') or '').startswith(PREFIX) and d['id'] not in changed_ids]
        after_unrelated = [d for d in after if not (d.get('slug') or '').startswith(PREFIX) and d['id'] not in changed_ids]
        if before_unrelated != after_unrelated:
            raise RuntimeError('Unrelated docs differ; inspect publication')
        expected = {p['slug']: p['content'] for p in plan['pages']}
        receipts = []
        for d in after:
            if d.get('slug') not in expected:
                continue
            public = fetch(f"https://{site}.ravenhash.org/api/v1/plugins/docs-api/public/docs/{d['id']}?lang=zh")
            detail = public.get('doc', public)
            if detail.get('content') != expected[d['slug']]:
                raise RuntimeError('Public document content mismatch: ' + d['slug'])
            receipts.append(dict(id=d['id'], title=d['title'], slug=d['slug'], url=f"https://{site}.ravenhash.org/docs/{d['id']}", sha256=hashlib.sha256(d['content'].encode()).hexdigest()))
        if len(receipts) != len(expected):
            raise RuntimeError('Published document count mismatch')
        tree = fetch(f'https://{site}.ravenhash.org/api/v1/plugins/docs-api/public/tree?lang=zh')
        if plan['directory']['slug'] not in json.dumps(tree):
            raise RuntimeError('Directory missing from public navigation')
        receipt = dict(site=site, revision=plan['revision'], modelCount=plan['modelCount'], backup=backup, documents=receipts)
        (OUT / f'{site}-receipt.json').write_text(json.dumps(receipt, ensure_ascii=False, indent=2), encoding='utf-8')
        print(json.dumps(receipt, ensure_ascii=False))
    finally:
        client.close()


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('action', choices=['prepare', 'deploy'])
    parser.add_argument('site', choices=['art', 'cart'])
    args = parser.parse_args()
    (prepare if args.action == 'prepare' else deploy)(args.site)
