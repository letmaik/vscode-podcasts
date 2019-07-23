import * as path from 'path'
import * as fs from 'fs'
import {promisify} from 'util';

import * as requestp from 'request-promise-native';
import * as parsePodcast_ from 'node-podcast-parser';
import { parseString as parseXML } from 'xml2js';
import { downloadFile, getAudioDuration } from './util';
import { mkdirp } from './3rdparty/util';
import { URL } from 'url';

const exists = promisify(fs.exists)
const readFile = promisify(fs.readFile)
const writeFile = promisify(fs.writeFile)
const unlink = promisify(fs.unlink)
const parsePodcast = promisify(parsePodcast_)

export interface EpisodeMetadata {
    title: string
    description: string
    duration?: number // seconds
    published: number // timestamp
    enclosureUrl: string
}

export interface PodcastMetadata {
    title: string
    description: string
    homepageUrl: string
    episodes: { [guid: string]: EpisodeMetadata }
    lastRefreshed: number // timestamp
    downloaded: { [guid: string]: string } // guid -> filename
}

interface StorageMetadata {
    podcasts: { [rssUrl: string]: PodcastMetadata }
}

export class Storage {
    private metadataPath: string
    private metadata: StorageMetadata
    private enclosuresPath: string

    constructor(private storagePath: string, private log: (msg: string) => void) {
        this.metadataPath = path.join(storagePath, 'metadata.json')
        this.enclosuresPath = path.join(storagePath, 'enclosures')
        mkdirp(storagePath)
        mkdirp(this.enclosuresPath)
    }

    async loadMetadata() {
        if (await exists(this.metadataPath)) {
            this.log(`Loading metadata from ${this.metadataPath}`)
            const json = await readFile(this.metadataPath, 'utf-8')
            this.metadata = JSON.parse(json)
        } else {
            this.metadata = {podcasts: {}}
        }
    }

    async saveMetadata() {
        this.log(`Saving metadata to ${this.metadataPath}`)
        const json = JSON.stringify(this.metadata, null, 1)
        await writeFile(this.metadataPath, json, 'utf-8')
    }

    getMetadata() {
        return this.metadata
    }

    hasPodcast(url: string) {
        return url in this.metadata.podcasts
    }

    getPodcast(url: string) {
        if (!this.hasPodcast(url)) {
            throw new Error(`Podcast ${url} not found in storage`)
        }
        return this.metadata.podcasts[url]
    }

    // TODO automatically purge old feed metadata if no associated download exists
    //      this will keep file and memory size down

    async fetchPodcast(url: string, updateIfOlderThan: number | undefined = undefined) {
        if (this.hasPodcast(url)) {
            if (updateIfOlderThan && this.getPodcast(url).lastRefreshed < updateIfOlderThan) {
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
            data = await requestp({uri: url})
        } catch (e) {
            this.log(`HTTP error: ${e}`)
            throw e
        }
    
        const podcast = await parsePodcast(data)
        const episodes: { [guid: string]: EpisodeMetadata } = {}
        for (const episode of podcast.episodes) {
            if (!episode.enclosure) {
                this.log(`Ignoring "${episode.title}" (GUID: ${episode.guid}), no enclosure found`)
                continue
            }
            episodes[episode.guid] = {
                title: episode.title,
                description: episode.description,
                published: new Date(episode.published).getTime(),
                duration: episode.duration,
                enclosureUrl: episode.enclosure.url
            }
        }

        let feed: PodcastMetadata = {
            title: podcast.title,
            description: podcast.description.short,
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

    private arePagesOverlapping(page1: PodcastMetadata, page2: PodcastMetadata | undefined): boolean {
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

    private appendPage(page1: PodcastMetadata, page2: PodcastMetadata | undefined): void {
        if (!page2) {
            return
        }
        for (const guid in page2.episodes) {
            page1.episodes[guid] = page2.episodes[guid]
        }
    }

    async updatePodcast(url: string) {
        const old = this.metadata.podcasts[url]

        this.log(`Updating podcast from ${url}`)

        let feed: PodcastMetadata | undefined = undefined
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

        this.metadata.podcasts[url] = feed!

        const invalidGuids = Object.keys(feed!.downloaded).filter(guid => !(guid in feed!.episodes))
        for (const guid in invalidGuids) {
            this.log(`Downloaded episode ${guid} does not appear in feed anymore, deleting`)
            this.deleteEpisodeEnclosure(url, guid, true)
        }

        this.saveMetadata()
    }

    async fetchEpisodeEnclosure(feedUrl: string, guid: string, onProgress?: (ratio: number) => void) {
        const feed = await this.fetchPodcast(feedUrl)
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
            await downloadFile(episode.enclosureUrl, enclosurePath, onProgress)
            feed.downloaded[guid] = enclosureFilename
            if (episode.duration === undefined) {
                try {
                    episode.duration = await getAudioDuration(enclosurePath)
                } catch (e) {
                    this.log(`Unable to read duration from ${enclosurePath}`)
                }
            }
            this.saveMetadata()
        }
        const enclosureFilename = feed.downloaded[guid]
        const enclosurePath = path.join(this.enclosuresPath, enclosureFilename)
        return enclosurePath
    }

    async deleteEpisodeEnclosure(feedUrl: string, guid: string, skipMetadataSave=false) {
        const feed = this.metadata.podcasts[feedUrl]
        const filename = feed.downloaded[guid]
        delete feed.downloaded[guid]
        const enclosurePath = path.join(this.enclosuresPath, filename)
        this.log(`Deleting downloaded episode ${enclosurePath}`)
        await unlink(enclosurePath)
        if (!skipMetadataSave) {
            this.saveMetadata()
        }
    }
}