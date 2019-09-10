import * as path from 'path'
import * as fs from 'fs'
import {promisify} from 'util';

import * as requestp from 'request-promise-native';
import parsePodcast from './3rdparty/podcast-parser';
import { parseString as parseXML } from 'xml2js';
import { downloadFile, getAudioDuration } from './util';
import { mkdirp } from './3rdparty/util';
import { URL } from 'url';
import { CancellationToken } from 'vscode';

const exists = promisify(fs.exists)
const readFile = promisify(fs.readFile)
const writeFile = promisify(fs.writeFile)
const unlink = promisify(fs.unlink)

export interface LocalEpisodeMetadata {
    title: string
    description?: string
    homepageUrl?: string
    duration?: number // seconds
    published?: number // timestamp
    enclosureUrl: string
}

export interface LocalDownloadedEpisodeMetadata {
    filename: string
}

export interface LocalPodcastMetadata {
    title: string
    description?: string
    homepageUrl: string
    episodes: { [guid: string]: LocalEpisodeMetadata }
    lastRefreshed: number // timestamp
    downloaded: { [guid: string]: LocalDownloadedEpisodeMetadata }
}

export interface LocalStorageMetadata {
    podcasts: { [rssUrl: string]: LocalPodcastMetadata }
}

export interface RoamingEpisodeMetadata {
    completed: boolean
    lastPosition?: number // seconds
    lastPlayed?: number // timestamp
}

export interface RoamingPodcastMetadata {
    starred: boolean
    episodes: { [guid: string]: RoamingEpisodeMetadata }
}

export interface RoamingStorageMetadata {
    podcasts: { [rssUrl: string]: RoamingPodcastMetadata }
}

export interface StorageMetadata {
    local: LocalStorageMetadata
    roaming: RoamingStorageMetadata
}

export interface LocalRoaming<L,R> {
    local?: L
    roaming?: R
}

export type PodcastMetadata = LocalRoaming<LocalPodcastMetadata, RoamingPodcastMetadata>
export type EpisodeMetadata = LocalRoaming<LocalEpisodeMetadata, RoamingEpisodeMetadata>

const DEFAULT_STORAGE_METADATA: StorageMetadata = {
    local: {
        podcasts: {}
    },
    roaming: {
        podcasts: {
            "https://rss.simplecast.com/podcasts/363/rss": { starred: true, episodes: {} },
            "https://feeds.simplecast.com/gvtxUiIf": { starred: true, episodes: {} },
            "http://feeds.feedburner.com/ProgrammingThrowdown": { starred: true, episodes: {} },
            "https://changelog.com/podcast/feed": { starred: true, episodes: {} },
            "https://feeds.simplecast.com/k0fI37e5": { starred: true, episodes: {} }
        }
    }
}

export class Storage {
    private localMetadataPath: string
    private roamingMetadataPath: string
    private metadata: StorageMetadata
    private enclosuresPath: string

    constructor(storagePath: string, private log: (msg: string) => void) {
        this.localMetadataPath = path.join(storagePath, 'local.json')
        // TODO allow to choose custom path for roaming metadata
        this.roamingMetadataPath = path.join(storagePath, 'roaming.json')
        this.enclosuresPath = path.join(storagePath, 'enclosures')
        mkdirp(storagePath)
        mkdirp(this.enclosuresPath)
    }

    async loadMetadata() {
        const meta = DEFAULT_STORAGE_METADATA
        if (await exists(this.localMetadataPath)) {
            this.log(`Loading local metadata from ${this.localMetadataPath}`)
            const json = await readFile(this.localMetadataPath, 'utf-8')
            meta.local = JSON.parse(json)
        }
        if (await exists(this.roamingMetadataPath)) {
            this.log(`Loading roaming metadata from ${this.roamingMetadataPath}`)
            const json = await readFile(this.roamingMetadataPath, 'utf-8')
            meta.roaming = JSON.parse(json)
        }
        this.metadata = meta
    }

    async saveMetadata(opts?: {local?: boolean, roaming?: boolean}) {
        if (!opts || opts.local) {
            this.purgeOldMetadata()
            this.log(`Saving local metadata to ${this.localMetadataPath}`)
            const jsonLocal = JSON.stringify(this.metadata.local, null, 1)
            await writeFile(this.localMetadataPath, jsonLocal, 'utf-8')
        }
        if (!opts || opts.roaming) {
            this.log(`Saving roaming metadata to ${this.roamingMetadataPath}`)
            const jsonRoaming = JSON.stringify(this.metadata.roaming, null, 1)
            await writeFile(this.roamingMetadataPath, jsonRoaming, 'utf-8')
        }
    }

    purgeOldMetadata() {
        const threshold = Date.now() - (1000 * 60 * 60 * 24 * 30) // 30 days
        const podcasts = this.metadata.local.podcasts
        const old = Object.entries(podcasts).filter(([feedUrl, podcast]) => 
            !this.isStarredPodcast(feedUrl) &&
            Object.keys(podcast.downloaded).length === 0 && podcast.lastRefreshed < threshold)
        for (const [url,_] of old) {
            this.log(`Purging old feed metadata for ${url}`)
            delete podcasts[url]
        }
    }

    getMetadata() {
        return this.metadata
    }

    hasLocalPodcast(url: string) {
        return url in this.metadata.local.podcasts
    }

    getPodcast(url: string): PodcastMetadata {
        return {
            local: this.metadata.local.podcasts[url],
            roaming: this.metadata.roaming.podcasts[url]
        }
    }

    getEpisode(feedUrl: string, guid: string): EpisodeMetadata {
        const podcast = this.getPodcast(feedUrl)
        return {
            local: podcast.local ? podcast.local.episodes[guid] : undefined,
            roaming: podcast.roaming ? podcast.roaming.episodes[guid] : undefined
        }
    }

    getStarredPodcastUrls() {
        return Object.entries(this.metadata.roaming.podcasts)
            .filter(([_, podcast]) => podcast.starred)
            .map(([feedUrl, _]) => feedUrl)
    }

    isStarredPodcast(feedUrl: string) {
        const podcast = this.metadata.roaming.podcasts[feedUrl]
        const starred = podcast && podcast.starred
        return starred
    }

    async fetchPodcast(url: string, updateIfOlderThan: number | undefined = undefined) {
        if (this.hasLocalPodcast(url)) {
            if (updateIfOlderThan && this.getPodcast(url).local!.lastRefreshed < updateIfOlderThan) {
                await this.updatePodcast(url)
            } else {
                this.log(`Using cached podcast metadata for ${url}`)
            }
        } else {
            await this.updatePodcast(url)
        }
        return this.getPodcast(url)
    }

    private async loadPodcastFeed(url: string) {
        this.log(`Requesting ${url}`)
        let data: any
        try {
            data = await requestp({
                url: url,
                headers: {
                    'User-Agent': 'Node'
                }
            })
        } catch (e) {
            this.log(`HTTP error: ${e}`)
            throw e
        }
    
        const podcast = await parsePodcast(data)
        const episodes: { [guid: string]: LocalEpisodeMetadata } = {}
        for (const episode of podcast.episodes) {
            if (!episode.enclosure) {
                this.log(`Ignoring "${episode.title}" (GUID: ${episode.guid}), no enclosure found`)
                continue
            }
            episodes[episode.guid || episode.enclosure.url] = {
                title: episode.title,
                description: episode.description.primary || episode.description.alternate,
                homepageUrl: episode.link,
                published: episode.published ? episode.published.getTime() : undefined,
                duration: episode.duration ? episode.duration : undefined,
                enclosureUrl: episode.enclosure.url
            }
        }

        let feed: LocalPodcastMetadata = {
            title: podcast.title,
            description: podcast.description.short || podcast.description.long,
            homepageUrl: podcast.link,
            lastRefreshed: Date.now(),
            episodes: episodes,
            downloaded: {}
        }

        // handle paged feeds
        let nextPageUrl: string | undefined
        try {
            nextPageUrl = await this.getNextPageUrl(data)
        } catch (e) {
            this.log(`Error extracting paging metadata in ${url}`)
        }

        return {feed, nextPageUrl}
    }

    private async getNextPageUrl(feedXml: string): Promise<string | undefined> {
        const feedObj = await new Promise((resolve, reject) => {
            parseXML(feedXml, (err, result) => {
                if (err) {
                    reject(err)
                }          
                resolve(result)
            })
        }) as any
        const links = feedObj.rss.channel[0]['atom:link']
        if (!links) {
            return
        }
        const nextLink = links.find(link => link['$'].rel === 'next')
        if (!nextLink) {
            return
        }
        const url = nextLink['$'].href
        return url
    }

    private arePagesOverlapping(page1: LocalPodcastMetadata, page2: LocalPodcastMetadata | undefined): boolean {
        if (!page2) {
            return false
        }
        for (const guid in page1.episodes) {
            if (guid in page2.episodes) {
                return true
            }
        }
        return false
    }

    private appendPage(page1: LocalPodcastMetadata, page2: LocalPodcastMetadata | undefined): void {
        if (!page2) {
            return
        }
        for (const guid in page2.episodes) {
            page1.episodes[guid] = page2.episodes[guid]
        }
    }

    async updatePodcast(url: string) {
        const old = this.metadata.local.podcasts[url]

        this.log(`Updating podcast from ${url}`)

        let feed: LocalPodcastMetadata | undefined = undefined
        let nextPageUrl: string | undefined = url
        while (nextPageUrl) {
            const page = await this.loadPodcastFeed(nextPageUrl)
            // When feeds are split into pages and we already downloaded the feed before,
            // then we only want to fetch new pages. To do that we stop when we encounter
            // the first overlap.
            if (this.arePagesOverlapping(page.feed, old)) {
                this.appendPage(page.feed, old)
                nextPageUrl = undefined
            } else {
                this.appendPage(page.feed, feed)
                nextPageUrl = page.nextPageUrl
            }
            feed = page.feed
        }

        if (old) {
            feed!.downloaded = old.downloaded
        }

        this.metadata.local.podcasts[url] = feed!

        const invalidGuids = Object.keys(feed!.downloaded).filter(guid => !(guid in feed!.episodes))
        for (const guid in invalidGuids) {
            this.log(`Downloaded episode ${guid} does not appear in feed anymore, deleting`)
            this.deleteEpisodeEnclosure(url, guid, true)
        }

        this.saveMetadata({local: true})
    }

    isEpisodeDownloaded(feedUrl: string, guid: string) {
        const podcast = this.getPodcast(feedUrl)
        const downloaded = podcast.local ? guid in podcast.local.downloaded : false
        return downloaded
    }

    async fetchEpisodeEnclosure(feedUrl: string, guid: string,
            onProgress?: (ratio: number) => void, token?: CancellationToken) {
        const feed = (await this.fetchPodcast(feedUrl)).local!
        const episode = feed.episodes[guid]
        if (!(guid in feed.downloaded)) {
            let enclosureFilename: string
            let enclosurePath: string
            do {
                const urlPath = new URL(episode.enclosureUrl).pathname
                const ext = path.extname(urlPath) || '.mp3'
                enclosureFilename = Math.random().toString(36).substring(2, 15) + ext
                enclosurePath = path.join(this.enclosuresPath, enclosureFilename)
            } while (fs.existsSync(enclosurePath))
    
            this.log(`Downloading ${episode.enclosureUrl} to ${enclosurePath}`)
            await downloadFile(episode.enclosureUrl, enclosurePath, onProgress, token)
            feed.downloaded[guid] = {
                filename: enclosureFilename
            }
            if (episode.duration === undefined) {
                try {
                    episode.duration = await getAudioDuration(enclosurePath)
                } catch (e) {
                    this.log(`Unable to read duration from ${enclosurePath}`)
                }
            }
            this.saveMetadata({local: true})
        }
        const enclosureFilename = feed.downloaded[guid].filename
        const enclosurePath = path.join(this.enclosuresPath, enclosureFilename)
        return enclosurePath
    }

    async deleteEpisodeEnclosure(feedUrl: string, guid: string, skipMetadataSave=false) {
        const feed = this.metadata.local.podcasts[feedUrl]
        const filename = feed.downloaded[guid].filename
        delete feed.downloaded[guid]
        const enclosurePath = path.join(this.enclosuresPath, filename)
        this.log(`Deleting downloaded episode ${enclosurePath}`)
        await unlink(enclosurePath)
        if (!skipMetadataSave) {
            await this.saveMetadata({local: true})
        }
    }

    getLastListeningPosition(feedUrl: string, guid: string) {
        const meta = this.getEpisode(feedUrl, guid)
        return meta.roaming && meta.roaming.lastPosition ? meta.roaming.lastPosition : 0
    }

    starPodcast(feedUrl: string, star: boolean) {
        const podcast = this.getOrCreateRoamingPodcast(feedUrl)
        podcast.starred = star
    }

    async storeListeningStatus(feedUrl: string, guid: string, completed: boolean, position: number | undefined = undefined) {
        const episode = this.getOrCreateRoamingEpisode(feedUrl, guid)
        episode.completed = completed
        episode.lastPosition = position
        episode.lastPlayed = Date.now()
        await this.saveMetadata({roaming: true})
    }

    private getOrCreateRoamingPodcast(feedUrl: string): RoamingPodcastMetadata {
        const podcasts = this.metadata.roaming.podcasts
        if (!(feedUrl in podcasts)) {
            podcasts[feedUrl] = {
                episodes: {},
                starred: false
            }
        }
        return podcasts[feedUrl]
    }

    private getOrCreateRoamingEpisode(feedUrl: string, guid: string): RoamingEpisodeMetadata {
        const podcast = this.getOrCreateRoamingPodcast(feedUrl)
        if (!(guid in podcast.episodes)) {
            podcast.episodes[guid] = {
                completed: false
            }
        }
        return podcast.episodes[guid]
    }

    getEpisodeDuration(feedUrl: string, guid: string): number | undefined {
        const duration = this.getEpisode(feedUrl, guid).local!.duration
        return duration
    }
}