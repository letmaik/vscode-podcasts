import * as fs from 'fs';
import * as path from 'path';
import { promisify } from 'util';
import * as tmp from 'tmp';
import * as request from 'request';
import * as requestProgress from 'request-progress';
import mp3Duration = require('./3rdparty/mp3-duration.js')
import { CancellationToken, Disposable } from 'vscode';
import { debounce } from './3rdparty/git/decorators';

const copyFile = promisify(fs.copyFile)
const unlink = promisify(fs.unlink)
export const readFile = promisify(fs.readFile)
export const writeFile = promisify(fs.writeFile)
const tmpName = promisify(tmp.tmpName)

export function toHumanDuration(sec?: number, fallback?: string): string {
    if (sec === undefined) {
        if (fallback === undefined) {
            throw new Error('Unknown duration and no fallback string defined')
        }
        return fallback
    }
    if (sec < 60) {
        return `${Math.round(sec)} s`
    }
    return Math.round(sec / 60) + ' min'
}

export function toHumanTimeAgo(timestamp: number) {
    const ms = Date.now() - timestamp
    const sec = ms / 1000
    const min = sec / 60
    if (min < 59.5) {
        return Math.round(min) + ' min ago'
    }
    const hours = min / 60
    if (hours < 23.5) {
        return Math.round(hours) + ' h ago'
    }
    const days = hours / 24
    if (days < 30) {
        return Math.round(days) + ' d ago'
    }
    const months = days / 30
    if (months < 11.5) {
        const monthsRounded = Math.round(months)
        const plural = monthsRounded > 1 ? 's' : ''
        return monthsRounded + ` month${plural} ago`
    }
    const years = months / 12
    const yearsRounded = Math.round(years)
    const plural = yearsRounded > 1 ? 's' : ''
    return Math.round(years) + ` year${plural} ago`
}

export async function downloadFile(url: string, path: string, 
        onProgress?: (ratio: number) => void, token?: CancellationToken): Promise<void> {
    const tmpPath = await tmpName({})
    const file = fs.createWriteStream(tmpPath)
    try {
        await new Promise((resolve, reject) => {
            const req = requestProgress(request({
                url: url,
                headers: {
                    'User-Agent': 'Node'
                }
            }))
            if (token) {
                token.onCancellationRequested(e => {
                    req.abort()
                    file.close()
                    reject(new Error('Download cancelled'))
                })
            }
            req.on('error', e => {
                file.close()
                reject(e)
            })
            if (onProgress) {
                req.on('progress', state => {
                    if (state.percent) {
                        onProgress(state.percent)
                    }
                })
            }
            req.on('response', response => {
                if (response.statusCode !== 200) {
                    file.close()
                    reject(new Error(`HTTP status was ${response.statusCode}, expected 200.`))
                    return
                }
                file.on('error', e => {
                    file.close()
                    reject(e)
                })
                file.on('finish', resolve)
                req.pipe(file)
            })
        })
        await copyFile(tmpPath, path)
    } finally {
        await unlink(tmpPath)
    }
}

const durationCache = new Map<string, number>()
export async function getAudioDuration(audioPath: string): Promise<number> {
    if (!durationCache.has(audioPath)) {
        if (path.extname(audioPath) !== '.mp3') {
            throw new Error('Cannot determine audio duration, only MP3 supported')
        }
        const duration = await mp3Duration(audioPath)
        if (duration == 0) {
            throw new Error('Unable to extract audio duration')
        }
        durationCache.set(audioPath, duration)
    }
    return durationCache.get(audioPath)!
}

// Uses fs.watch until https://github.com/microsoft/vscode/issues/3025 lands.
export class FileWatcher {
    readonly disposable: Disposable
    private watcher: fs.FSWatcher

    constructor(filename: string, private onChange: () => void) {
        this.update(filename)
        this.disposable = new Disposable(() => this.watcher.close())
    }

    update(filename: string) {
        if (this.watcher) {
            this.watcher.close()
        }
        this.watcher = fs.watch(filename, {
            persistent: false
        }, (event: string) => {
            if (event === 'change') {
                this.onChangeDebounced()
            }
        })
    }

    // https://stackoverflow.com/a/18808697
    @debounce(500)
    private onChangeDebounced() {
        this.onChange()
    }
}
