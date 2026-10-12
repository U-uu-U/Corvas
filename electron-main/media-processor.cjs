const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const sharp = require('sharp');
const { boardMediaType } = require('../shared/board-media-policy.cjs');

function mediaToolPaths({ packaged = false, resourcesPath = process.resourcesPath, platform = process.platform } = {}) {
    if (packaged) {
        const suffix = platform === 'win32' ? '.exe' : '';
        return { ffmpeg: path.join(resourcesPath, 'media-tools', 'ffmpeg'+suffix),
            ffprobe: path.join(resourcesPath, 'media-tools', 'ffprobe'+suffix) };
    }
    return { ffmpeg: require('ffmpeg-static'), ffprobe: require('ffprobe-static').path };
}

function canceledError() {
    return Object.assign(new Error('已取消素材处理'), { code: 'MEDIA_PROCESS_CANCELED' });
}

function runTool(executable, args, { signal, timeout = 30 * 60 * 1000, onOutput } = {}) {
    if (signal?.aborted) return Promise.reject(canceledError());
    return new Promise((resolve, reject) => {
        let stdout = '', stderr = '', failed = null;
        const child = spawn(executable, args, { windowsHide: true, shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
        const cancel = () => { failed = canceledError(); child.kill(); };
        signal?.addEventListener('abort', cancel, { once: true });
        const timer = setTimeout(() => { failed = new Error('处理超时，请缩短片段后重试'); child.kill(); }, timeout);
        const finish = () => { clearTimeout(timer); signal?.removeEventListener('abort', cancel); };
        child.stdout.on('data', chunk => {
            if (onOutput) onOutput(chunk.toString('utf8'));
            else {
                stdout += chunk.toString('utf8');
                if (stdout.length > 2 * 1024 * 1024) { failed = new Error('素材信息过大，无法读取'); child.kill(); }
            }
        });
        child.stderr.on('data', chunk => { stderr = (stderr+chunk.toString('utf8')).slice(-8192); });
        child.once('error', error => {
            finish();
            reject(error.code === 'ENOENT' ? new Error('转换组件缺失，请修复应用安装') : error);
        });
        child.once('close', code => {
            finish();
            if (failed) reject(failed);
            else if (code !== 0) reject(new Error(/Invalid data|Invalid argument|not contain any stream|Error opening input/i.test(stderr)
                ? '素材无法解码，请检查文件是否完整或选择其他格式'
                : /No space left|not enough space/i.test(stderr) ? '磁盘空间不足，无法保存处理结果' : '素材处理失败，请检查文件格式和片段范围'));
            else resolve(stdout);
        });
    });
}

function number(value, fallback, min, max, label, integer = false) {
    const result = value === undefined || value === null ? fallback : value;
    if (typeof result !== 'number' || !Number.isFinite(result) || result < min || result > max || (integer && !Number.isInteger(result))) {
        throw new Error(`${label}需要在 ${min} 到 ${max} 之间${integer ? '，且为整数' : ''}`);
    }
    return result;
}

function optionsFor(info, options = {}) {
    if (!options || typeof options !== 'object' || Array.isArray(options)) throw new Error('处理选项无效');
    const formats = { image: ['png', 'jpg', 'webp'], audio: ['mp3', 'wav'], video: ['mp4'] };
    const format = options.format || formats[info.kind]?.[0];
    if (!formats[info.kind]?.includes(format)) throw new Error('不支持这个输出格式');
    if (info.kind === 'image') {
        const width = number(options.width, info.width, 1, 16384, '宽度', true);
        const height = number(options.height, info.height, 1, 16384, '高度', true);
        if (width * height > 64 * 1024 * 1024) throw new Error('输出图片不能超过 6400 万像素');
        return { format, width, height, quality: number(options.quality, 90, 1, 100, '质量', true), keepAspect: options.keepAspect !== false };
    }
    if (!(info.duration > 0)) throw new Error('无法读取素材时长');
    const start = number(options.start, 0, 0, info.duration, '开始时间');
    const end = number(options.end, info.duration, 0, info.duration, '结束时间');
    if (end-start < 0.05) throw new Error('结束时间需要晚于开始时间，片段至少 0.05 秒');
    if (info.kind === 'audio') {
        const bitrate = options.bitrate ?? 192;
        if (![128, 192, 320].includes(bitrate)) throw new Error('请选择 128、192 或 320 kbps');
        return { format, start, end, bitrate };
    }
    const maxEdge = options.maxEdge ?? 1280;
    if (![0, 854, 1280, 1920].includes(maxEdge)) throw new Error('不支持这个视频尺寸');
    const quality = options.quality || 'standard';
    if (!['high', 'standard', 'small'].includes(quality)) throw new Error('不支持这个视频质量');
    return { format, start, end, maxEdge, quality, keepAudio: options.keepAudio !== false && info.hasAudio };
}

function ffmpegArguments(filePath, destination, info, options) {
    const args = ['-hide_banner', '-loglevel', 'error', '-nostdin', '-n', '-protocol_whitelist', 'file,pipe',
        '-ss', String(options.start), '-i', filePath, '-t', String(options.end-options.start), '-map_metadata', '-1', '-sn', '-dn'];
    if (info.kind === 'audio') {
        args.push('-map', '0:a:0', '-vn', '-ac', '2');
        if (options.format === 'mp3') args.push('-c:a', 'libmp3lame', '-b:a', options.bitrate+'k', '-ar', '44100');
        else args.push('-c:a', 'pcm_s16le', '-ar', '48000');
    } else {
        args.push('-map', '0:v:0');
        if (options.keepAudio) args.push('-map', '0:a:0?', '-c:a', 'aac', '-b:a', '192k');
        else args.push('-an');
        const scale = options.maxEdge
            ? `scale=w='min(iw,${options.maxEdge})':h='min(ih,${options.maxEdge})':force_original_aspect_ratio=decrease:force_divisible_by=2`
            : 'scale=trunc(iw/2)*2:trunc(ih/2)*2';
        args.push('-vf', scale, '-c:v', 'libx264', '-preset', 'veryfast', '-crf', String({ high: 18, standard: 23, small: 28 }[options.quality]),
            '-pix_fmt', 'yuv420p', '-movflags', '+faststart');
    }
    args.push('-threads', '2', '-progress', 'pipe:1', '-nostats', destination);
    return args;
}

class MediaProcessor {
    constructor({ outputDir, tools = mediaToolPaths(), resolveFile = async file => ({ filePath: file }), grantFile = async () => {} }) {
        this.outputDir = outputDir;
        this.tools = tools;
        this.resolveFile = resolveFile;
        this.grantFile = grantFile;
        this.active = null;
    }

    async inspect(inputPath, signal) {
        const { filePath } = await this.resolveFile(inputPath);
        const stat = await fs.promises.stat(filePath);
        if (!stat.isFile()) throw new Error('请选择素材文件');
        const kind = boardMediaType(filePath);
        if (!['image', 'audio', 'video'].includes(kind)) throw new Error('仅支持图片、视频和音频素材');
        const common = { filePath, name: path.basename(filePath), kind, bytes: stat.size };
        if (kind === 'image') {
            const meta = await sharp(filePath, { limitInputPixels: 128 * 1024 * 1024 }).metadata();
            const swap = [5, 6, 7, 8].includes(meta.orientation);
            return { ...common, format: meta.format, width: swap ? meta.height : meta.width, height: swap ? meta.width : meta.height,
                duration: null, hasAudio: false };
        }
        const raw = await runTool(this.tools.ffprobe, ['-v', 'error', '-protocol_whitelist', 'file,pipe', '-show_format', '-show_streams', '-of', 'json', filePath],
            { signal, timeout: 20000 });
        const data = JSON.parse(raw);
        const audio = data.streams?.find(stream => stream.codec_type === 'audio');
        const video = data.streams?.find(stream => stream.codec_type === 'video' && !stream.disposition?.attached_pic);
        if (kind === 'audio' ? !audio : !video) throw new Error('文件内容与素材类型不符，无法处理');
        const duration = Number(data.format?.duration || (kind === 'video' ? video?.duration : audio?.duration));
        if (!Number.isFinite(duration) || duration <= 0) throw new Error('无法读取素材时长');
        const rotation = Number(video?.side_data_list?.find(item => item.rotation !== undefined)?.rotation || video?.tags?.rotate || 0);
        const swap = Math.abs(rotation)%180 === 90;
        let format = data.format?.format_name?.split(',')[0];
        if (format === 'mov') format = String(data.format?.tags?.major_brand || '').trim() === 'qt' ? 'mov' : kind === 'audio' ? 'm4a' : 'mp4';
        return { ...common, format, duration, hasAudio: Boolean(audio),
            width: video ? Number(swap ? video.height : video.width) : null,
            height: video ? Number(swap ? video.width : video.height) : null,
            videoCodec: video?.codec_name || null, audioCodec: audio?.codec_name || null };
    }

    async convert(request, onProgress = () => {}, owner = null) {
        if (this.active) throw new Error('已有素材正在处理，请等待完成或取消');
        if (!request || typeof request.jobId !== 'string' || !/^[A-Za-z0-9_-]{1,100}$/.test(request.jobId)) throw new Error('处理任务编号无效');
        const job = { id: request.jobId, controller: new AbortController(), owner, done: null };
        this.active = job;
        const progress = (stage, percent) => onProgress({ jobId: job.id, stage, percent });
        job.done = (async () => {
            let temporary = null;
            let finalPath = null;
            try {
                progress('prepare', 0);
                const info = await this.inspect(request.filePath, job.controller.signal);
                const options = optionsFor(info, request.options);
                if (job.controller.signal.aborted) throw canceledError();
                await fs.promises.mkdir(this.outputDir, { recursive: true });
                const name = path.parse(info.name).name.replace(/[<>:"/\\|?*]/g, '_').replace(/^[. ]+|[. ]+$/g, '').slice(0, 70) || 'media';
                const token = crypto.randomUUID();
                finalPath = path.join(this.outputDir, `${name}-processed-${Date.now()}-${token.slice(0, 8)}.${options.format}`);
                temporary = path.join(this.outputDir, `.${token}.partial.${options.format}`);
                progress('processing', 1);
                if (info.kind === 'image') {
                    let pipeline = sharp(info.filePath, { limitInputPixels: 128 * 1024 * 1024 }).rotate()
                        .resize(options.width, options.height, { fit: options.keepAspect ? 'inside' : 'fill' });
                    if (options.format === 'jpg') pipeline = pipeline.flatten({ background: '#ffffff' }).jpeg({ quality: options.quality });
                    else if (options.format === 'webp') pipeline = pipeline.webp({ quality: options.quality });
                    else pipeline = pipeline.png({ compressionLevel: 8 });
                    await pipeline.toFile(temporary);
                } else {
                    let pending = '', last = 0;
                    await runTool(this.tools.ffmpeg, ffmpegArguments(info.filePath, temporary, info, options), {
                        signal: job.controller.signal,
                        onOutput: text => {
                            pending += text;
                            const lines = pending.split('\n');
                            pending = lines.pop();
                            for (const line of lines) {
                                const [key, value] = line.trim().split('=');
                                if (key === 'out_time_us' && Number.isFinite(Number(value))) {
                                    const percent = Math.min(98, Math.max(1, Number(value)/1000000/(options.end-options.start)*100));
                                    if (percent-last >= 1) { last = percent; progress('processing', percent); }
                                }
                            }
                        }
                    });
                }
                if (job.controller.signal.aborted) throw canceledError();
                const stat = await fs.promises.stat(temporary);
                if (!stat.size) throw new Error('处理结果为空，未添加到画布');
                await fs.promises.rename(temporary, finalPath);
                temporary = null;
                await this.grantFile(finalPath);
                const result = await this.inspect(finalPath, job.controller.signal);
                if (job.controller.signal.aborted) throw canceledError();
                progress('complete', 100);
                return { ...result, sourcePath: info.filePath, jobId: job.id };
            } catch (error) {
                if (temporary) await fs.promises.unlink(temporary).catch(() => {});
                if (finalPath) await fs.promises.unlink(finalPath).catch(() => {});
                throw error;
            } finally { if (this.active === job) this.active = null; }
        })();
        return job.done;
    }

    cancel(jobId, owner = null) {
        if (!this.active || this.active.id !== jobId || this.active.owner !== owner) return false;
        this.active.controller.abort();
        return true;
    }

    async close() {
        this.active?.controller.abort();
        await this.active?.done?.catch(() => {});
    }
}

module.exports = { MediaProcessor, mediaToolPaths, optionsFor, ffmpegArguments };
