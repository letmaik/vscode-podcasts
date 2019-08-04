export interface SearchConfiguration {
    genres: string[]
    sortByDate: boolean
    language: string
    minimumLength: number
    maximumLength: number
}

export interface Feed {
    title: string
    url: string
}

export interface Configuration {
    feeds: Feed[]
    player?: string
    search: SearchConfiguration
}

export enum PlayerStatus {
    DOWNLOADING,
    OPENING,
    PLAYING,
    PAUSED,
    STOPPED
}

export interface PlayerState {
    status: PlayerStatus,
    downloadProgress?: number,
    duration?: number,
    elapsed?: number
}