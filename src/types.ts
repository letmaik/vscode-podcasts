export interface PlayerConfiguration {
    path?: string
}

export interface StorageConfiguration {
    roamingPath?: string
}

export interface SearchConfiguration {
    genres: string[]
    sortByDate: boolean
    language: string
    minimumLength: number
    maximumLength: number
}

export interface Configuration {
    player: PlayerConfiguration
    storage: StorageConfiguration
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