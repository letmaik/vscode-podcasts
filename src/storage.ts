import * as path from 'path'
import * as fs from 'fs'
import {promisify} from 'util';

import * as requestp from 'request-promise-native';
import * as parsePodcast_ from 'node-podcast-parser';
import { downloadFile } from './util';
import { mkdirp } from './3rdparty/util';

const exists = promisify(fs.exists)
const readFile = promisify(fs.readFile)
const writeFile = promisify(fs.writeFile)
const unlink = promisify(fs.unlink)
const parsePodcast = promisify(parsePodcast_)

export interface EpisodeMetadata {
    title: string
    description: string
    duration: number // seconds
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
    metadataPath: string
    metadata: StorageMetadata
    enclosuresPath: string

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

    async fetchPodcast(url: string) {
        if (!this.hasPodcast(url)) {
            await this.updatePodcast(url)
        } else {
            this.log(`Using cached podcast metadata for ${url}`)
        }
        return this.getPodcast(url)
    }

    async updatePodcast(url: string) {
        this.log(`Updating podcast from ${url}`)
        const data = await requestp({uri: url, json: true})
        const podcast = await parsePodcast(data)

        const episodes: { [guid: string]: EpisodeMetadata } = {}
        for (const episode of podcast.episodes) {
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

        if (url in this.metadata.podcasts) {
            feed.downloaded = this.metadata.podcasts[url].downloaded
        }

        this.metadata.podcasts[url] = feed

        const invalidGuids = Object.keys(feed.downloaded).filter(guid => !(guid in feed.episodes))
        for (const guid in invalidGuids) {
            this.log(`Downloaded episode ${guid} does not appear in feed anymore, deleting`)
            this.deleteEpisodeEnclosure(url, guid, true)
        }

        this.saveMetadata()
    }

    async fetchEpisodeEnclosure(feedUrl: string, guid: string) {
        const feed = await this.fetchPodcast(feedUrl)
        const episode = feed.episodes[guid]
        if (!(guid in feed.downloaded)) {
            let enclosureFilename: string
            let enclosurePath: string
            do {
                const ext = path.extname(episode.enclosureUrl) || '.mp3'
                enclosureFilename = Math.random().toString(36).substring(2, 15) + ext
                enclosurePath = path.join(this.enclosuresPath, enclosureFilename)
            } while (fs.existsSync(enclosurePath))
    
            this.log(`Downloading ${episode.enclosureUrl} to ${enclosurePath}`)
            await downloadFile(episode.enclosureUrl, enclosurePath)
            feed.downloaded[guid] = enclosureFilename
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