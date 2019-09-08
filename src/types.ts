export interface SearchConfiguration {
    genres: string[]
    sortByDate: boolean
    language: string
    minimumLength: number
    maximumLength: number
}

export interface Configuration {
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