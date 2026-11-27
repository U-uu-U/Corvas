#!/usr/bin/env node
// Manual check of the 3D generation adapters against the real provider APIs.
// Keys come from the environment only: MESHY_API_KEY, TRIPO_API_KEY, HYPER3D_API_KEY (or RODIN_API_KEY).
// Behind a proxy, run with:  node --use-env-proxy scripts/model3d-cli.cjs ...  and HTTPS_PROXY set.
const fs = require('node:fs');
const path = require('node:path');
const { parseArgs } = require('node:util');
const { MODEL3D_PROVIDERS, generateModel3d, resumeModel3d, queryModel3d, cancelModel3d, getModel3dBalance } = require('../electron-main/model3d-providers.cjs');

const KEY_VARIABLES = { meshy: ['MESHY_API_KEY'], tripo: ['TRIPO_API_KEY'], hyper3d: ['HYPER3D_API_KEY', 'RODIN_API_KEY'] };
const USAGE = `用法：
  node scripts/model3d-cli.cjs providers
  node scripts/model3d-cli.cjs balance <meshy|tripo|hyper3d> [--region cn]
  node scripts/model3d-cli.cjs generate <meshy|tripo|hyper3d> --mode <text|image|multiview> [--prompt 文本] [--image 路径 ...]
        [--model 标识] [--format glb] [--no-texture] [--no-pbr] [--topology quad] [--faces 数量] [--seed 数字]
        [--out 目录] [--region cn] --yes
  node scripts/model3d-cli.cjs status <任务记录.json>
  node scripts/model3d-cli.cjs resume <任务记录.json> [--out 目录] [--resubmit-unknown-stage]
  node scripts/model3d-cli.cjs cancel <任务记录.json>

balance 和 status 不消耗积分。generate 会消耗积分，必须加 --yes。
任务记录保存在 --out 目录（默认 output/model3d），中断后用 resume 续跑，不会重新提交第一步。`;

function configFor(provider, values) {
    if (!MODEL3D_PROVIDERS[provider]) throw new Error(`未知的服务：${provider || '(空)'}。可用：${Object.keys(MODEL3D_PROVIDERS).join('、')}`);
    const variable = KEY_VARIABLES[provider].find(name => process.env[name]);
    if (!variable) throw new Error(`请先设置环境变量 ${KEY_VARIABLES[provider].join(' 或 ')}`);
    return { apiKey: process.env[variable], ...(values.region ? { region: values.region } : {}), ...(values['base-url'] ? { baseUrl: values['base-url'] } : {}) };
}

function readHandle(file) {
    if (!file) throw new Error('缺少任务记录文件');
    const record = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!record?.handle?.provider) throw new Error('任务记录文件格式不对');
    return record;
}

async function main() {
    const { values, positionals } = parseArgs({ allowPositionals: true, options: {
        mode: { type: 'string' }, prompt: { type: 'string' }, image: { type: 'string', multiple: true }, model: { type: 'string' },
        format: { type: 'string' }, 'no-texture': { type: 'boolean' }, 'no-pbr': { type: 'boolean' }, topology: { type: 'string' },
        faces: { type: 'string' }, seed: { type: 'string' }, out: { type: 'string' }, region: { type: 'string' }, 'base-url': { type: 'string' },
        yes: { type: 'boolean' }, 'resubmit-unknown-stage': { type: 'boolean' }, help: { type: 'boolean', short: 'h' } } });
    const [command, target] = positionals;
    if (values.help || !command) return console.log(USAGE);
    const outDir = path.resolve(values.out || path.join('output', 'model3d'));
    const controller = new AbortController();
    process.once('SIGINT', () => controller.abort());
    const saveHandle = (file, record) => handle => {
        fs.mkdirSync(path.dirname(file()), { recursive: true });
        fs.writeFileSync(file(), JSON.stringify({ ...record, handle }, null, 2));
        console.log(`任务记录已保存：${file()}（阶段 ${handle.stage}${handle.advancing ? `，正在提交 ${handle.advancing}` : ''}，任务 ${handle.taskId}）`);
    };
    let last = '';
    const onProgress = ({ status, recovering }) => {
        const line = recovering ? '查询失败，稍后重试' : `${status.state}${status.progress === null ? '' : ` ${status.progress}%`}（${status.remoteStatus}）`;
        if (line !== last) console.log(line);
        last = line;
    };
    const report = result => {
        console.log(`完成。消耗积分：${result.status.creditsConsumed ?? '服务商未报告'}`);
        for (const file of result.files) console.log(`已下载 ${file.role}：${file.path}（${file.bytes} 字节）`);
        if (!result.files.length) for (const output of result.outputs) console.log(`${output.role} ${output.format || ''}: ${output.url}`);
    };

    if (command === 'providers') {
        for (const info of Object.values(MODEL3D_PROVIDERS)) {
            console.log(`${info.id}\t${info.name}\t默认模型 ${info.defaultModel}\t格式 ${info.formats.join(',')}\t文档 ${info.docs}`);
        }
    } else if (command === 'balance') {
        console.log(JSON.stringify(await getModel3dBalance({ provider: target, config: configFor(target, values), signal: controller.signal }), null, 2));
    } else if (command === 'generate') {
        const config = configFor(target, values);
        if (!values.yes) throw new Error('generate 会消耗积分。确认后加上 --yes 再运行');
        const request = { mode: values.mode, prompt: values.prompt, images: values.image || [], model: values.model, format: values.format,
            texture: !values['no-texture'], pbr: values['no-texture'] || values['no-pbr'] ? false : undefined, topology: values.topology,
            targetFaces: values.faces === undefined ? undefined : Number(values.faces), seed: values.seed === undefined ? undefined : Number(values.seed) };
        const started = new Date().toISOString().replace(/[:.]/g, '-');
        const record = { provider: target, region: values.region || null, baseUrl: values['base-url'] || null, startedAt: started };
        report(await generateModel3d({ provider: target, config, request, signal: controller.signal, saveDir: outDir,
            baseName: `${target}-${started}`, onProgress, onHandle: saveHandle(() => path.join(outDir, `${target}-${started}.task.json`), record) }));
    } else if (['status', 'resume', 'cancel'].includes(command)) {
        const record = readHandle(target);
        const provider = record.handle.provider;
        const config = configFor(provider, { region: record.region, 'base-url': record.baseUrl });
        if (command === 'status') {
            console.log(JSON.stringify(await queryModel3d({ provider, config, handle: record.handle, signal: controller.signal }), null, 2));
        } else if (command === 'cancel') {
            console.log(JSON.stringify(await cancelModel3d({ provider, config, handle: record.handle, signal: controller.signal }), null, 2));
        } else {
            report(await resumeModel3d({ provider, config, handle: record.handle, signal: controller.signal, saveDir: outDir,
                baseName: path.basename(target).replace(/\.task\.json$/i, ''), onProgress,
                resubmitUnknownStage: Boolean(values['resubmit-unknown-stage']), onHandle: saveHandle(() => path.resolve(target), record) }));
        }
    } else {
        throw new Error(`未知命令：${command}\n\n${USAGE}`);
    }
    return undefined;
}

main().catch(error => {
    console.error(error?.message || error);
    if (error?.code) console.error(`错误码 ${error.code}；确定未创建任务：${Boolean(error.confirmedFailure)}；任务可能已创建：${Boolean(error.submissionUnknown)}`);
    if (error?.handle) console.error(`任务记录：${JSON.stringify(error.handle)}`);
    if (error?.retryHandle) console.error(`只重做失败的这一步，可以从上一步的任务记录续跑：${JSON.stringify(error.retryHandle)}`);
    process.exitCode = 1;
});
