import * as requestp from 'request-promise-native'
import * as LRU from 'lru-cache'
import {LISTEN_API_KEY} from './constants'

export interface SearchOptions {
    genres: string[]
    sortByDate: boolean
    language: string
    minimumLength: number
    maximumLength: number
    offset: number
}

export interface SearchResult<TSearchResultEntry> {
    count: number
    total: number
    next_offset: number
    results: TSearchResultEntry[]
}

export interface PodcastResult {
    id: string // podcast ID unique to Listen Notes
    rss: string // feed URL (redirect via Listen Notes)
    image: string // image URL (redirect via Listen Notes)
    thumbnail: string // thumbnail URL (redirect via Listen Notes)
    genre_ids: number[]
    title_original: string
    description_original: string
    earliest_pub_date_ms: number // UNIX timestamp (ms)
    latest_pub_date_ms: number // UNIX timestamp (ms)
    total_episodes: number
}

export interface EpisodeResult {
    id: string // episode ID unique to Listen Notes
    podcast_id: string // podcast ID unique to Listen Notes
    rss: string // feed URL (redirect via Listen Notes)
    audio: string // audio URL (redirect via Listen Notes)
    image: string // image URL (redirect via Listen Notes)
    thumbnail: string // thumbnail URL (redirect via Listen Notes)
    genre_ids: number[]
    title_original: string
    description_original: string
    podcast_title_original: string
    pub_date_ms: number // UNIX timestamp (ms)
    audio_length_sec: number
}

// Top-level genres only at the moment.
const Genres = {
    "TV & Film": 68,
    "Religion & Spirituality": 69,
    "Sports & Recreation": 77,
    "Games & Hobbies": 82,
    "Health": 88,
    "Business": 93,
    "News & Politics": 99,
    "Arts": 100,
    "Science & Medicine": 107,
    "Education": 111,
    "Government & Organizations": 117,
    "Society & Culture": 122,
    "Technology": 127,
    "Kids & Family": 132,
    "Comedy": 133,
    "Music": 134,
    "Personal Finance": 144,
    "Locally Focused": 151
}

function getGenreIdsParam(names: string[]): string {
    return names.map(name => Genres[name]).join(',')
}

const HEADERS = {'X-ListenAPI-Key': LISTEN_API_KEY}

export class ListenNotes {
    private redirectCache = new Map<string,string>()
    private responseCache = new LRU<string,any>({
        max: 100,
        maxAge: 1000 * 60 * 60 // 1h
    })

    constructor(private log: (msg: string) => void) {
    }

    async searchPodcasts(query: string, opts: SearchOptions): Promise<SearchResult<PodcastResult>>  {
        const url = `https://listen-api.listennotes.com/api/v2/search?q=${encodeURIComponent(query)}&` +
            `sort_by_date=${opts.sortByDate ? '1' : '0'}&type=podcast&offset=${opts.offset}&` +
            `genre_ids=${getGenreIdsParam(opts.genres)}&language=${opts.language}`
        const cached = this.responseCache.get(url)
        if (cached) {
            this.log(`Using cached Listen Notes API response: ${url}`)
            return cached
        }
        this.log(`Querying Listen Notes API: ${url}`)
        const data = await requestp({url, headers: HEADERS, json: true}) as SearchResult<PodcastResult>
        this.log(`Received ${data.count} of ${data.total} results`)
        this.responseCache.set(url, data)
        return data
    }

    async searchEpisodes(query: string, opts: SearchOptions): Promise<SearchResult<EpisodeResult>>  {
        const url = `https://listen-api.listennotes.com/api/v2/search?q=${encodeURIComponent(query)}&` +
            `sort_by_date=${opts.sortByDate ? '1' : '0'}&type=episode&offset=${opts.offset}&` +
            `len_min=${opts.minimumLength}&len_max=${opts.maximumLength}&` +
            `genre_ids=${getGenreIdsParam(opts.genres)}&language=${opts.language}`
        const cached = this.responseCache.get(url)
        if (cached) {
            this.log(`Using cached Listen Notes API response: ${url}`)
            return cached
        }
        this.log(`Querying Listen Notes API: ${url}`)
        const data = await requestp({url, headers: HEADERS, json: true}) as SearchResult<EpisodeResult>
        this.log(`Received ${data.count} of ${data.total} results`)
        this.responseCache.set(url, data)
        return data
    }

    async resolveRedirect(url: string): Promise<string> {
        if (this.redirectCache.has(url)) {
            return this.redirectCache.get(url)!
        }
        const response = await requestp({
            url: url,
            headers: HEADERS,
            followRedirect: false,
            simple: false, // avoid error on 301
            resolveWithFullResponse: true
        })
        if (!response.headers.location) {
            this.log(`Expected redirect for ${url} but none found`)
            return url
        }
        const redirectUrl = response.headers.location
        this.redirectCache.set(url, redirectUrl)
        return redirectUrl
    }
}
