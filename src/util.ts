import * as fs from 'fs';
import * as request from 'request';
import {promisify} from 'util';
import * as tmp from 'tmp';

const copyFile = promisify(fs.copyFile)
const unlink = promisify(fs.unlink)
const tmpName = promisify(tmp.tmpName)

export function toHumanDuration(sec: number) {
    return Math.round(sec / 60) + ' min';
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

export async function downloadFile(url: string, path: string): Promise<void> {
    const tmpPath = await tmpName({})
    const file = fs.createWriteStream(tmpPath)
    try {
        await new Promise((resolve, reject) => {
            const req = request({url})
            req.on('error', e => {
                file.close()
                reject(e)
            })
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
