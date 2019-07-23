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