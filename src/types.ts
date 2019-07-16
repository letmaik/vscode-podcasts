import { QuickPickItem } from "vscode";

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
    player: string | undefined
    search: SearchConfiguration
}

export interface EpisodeItem extends QuickPickItem {
    guid: string
}

export interface PodcastItem extends QuickPickItem {
    url: string
}