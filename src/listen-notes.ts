import * as requestp from 'request-promise-native';
import {LISTEN_API_KEY} from './constants'

export interface SearchOptions {
    genres: string[]
    sortByDate: boolean
    language: string
    minimumLength: number
    maximumLength: number
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

export async function searchPodcasts(query: string, opts: SearchOptions): Promise<PodcastResult[]>  {
    const url = `https://listen-api.listennotes.com/api/v2/search?q=${encodeURIComponent(query)}&` +
        `sort_by_date=${opts.sortByDate ? '1' : '0'}&type=podcast&offset=0&` +
        `genre_ids=${getGenreIdsParam(opts.genres)}&language=${opts.language}`
    const headers = {'X-ListenAPI-Key': LISTEN_API_KEY}
    const data = await requestp({url, headers, json: true})
    const results = data.results as PodcastResult[]
    return results
}

export async function searchEpisodes(query: string, opts: SearchOptions): Promise<EpisodeResult[]>  {
    const url = `https://listen-api.listennotes.com/api/v2/search?q=${encodeURIComponent(query)}&` +
        `sort_by_date=${opts.sortByDate ? '1' : '0'}&type=episode&offset=0&` +
        `len_min=${opts.minimumLength}&len_max=${opts.maximumLength}&` +
        `genre_ids=${getGenreIdsParam(opts.genres)}&language=${opts.language}`
    const headers = {'X-ListenAPI-Key': LISTEN_API_KEY}
    const data = await requestp({url, headers, json: true})
    const results = data.results as EpisodeResult[]
    return results
}
