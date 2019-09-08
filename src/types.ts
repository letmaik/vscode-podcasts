export interface SearchConfiguration {
    genres: string[]
    sortByDate: boolean
    language: string
    minimumLength: number
    maximumLength: number
}

export interface StarredFeed {
    title: string
    url: string
}

export interface Configuration {
    starred: StarredFeed[]
    playerPath?: string
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