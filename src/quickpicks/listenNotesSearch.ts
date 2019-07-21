import { window, QuickPickItem, QuickPick } from "vscode";
import { SearchResult, PodcastResult, ListenNotes, EpisodeResult } from "../listenNotes";
import { toHumanTimeAgo, toHumanDuration } from "../util";
import { SearchConfiguration } from "../types";
import { debounce } from "../3rdparty/git/decorators";

class LoadMoreItem implements QuickPickItem {
    constructor(public query: string, public nextOffset: number, private total: number) {}
    
    alwaysShow = true
    label = '⭮ Load more...'
    description = `Remaining: ${this.total - this.nextOffset}`
}

abstract class ListenNotesSearchQuickPick<TResultItem extends QuickPickItem, TSearchResultEntry, TReturnValue> {
    private quickpick: QuickPick<TResultItem | LoadMoreItem>
    private items: TResultItem[]

    constructor(private title: string, protected log: (msg: string) => void) {
    }

    async show(): Promise<TReturnValue | undefined> {
        const pick = window.createQuickPick<TResultItem | LoadMoreItem>()
        this.quickpick = pick
        pick.title = this.title
        pick.placeholder = 'Enter a search term'
        pick.ignoreFocusOut = true
        // TODO disable automatic sorting & filtering based on filter string (not available yet)
        //      otherwise lazy loading of more items is confusing and some results may be omitted
        pick.matchOnDescription = true
        pick.matchOnDetail = true

        pick.onDidChangeValue(query => {
            pick.items = []
            if (!query) {
                return
            }
            pick.busy = true
            this.searchAndUpdateItems(query, 0)
        })

        const pickerPromise = new Promise<TResultItem | undefined>((resolve, _) => {
            pick.onDidAccept(() => {
                const items = pick.selectedItems
                if (items.length > 0) {
                    const item = pick.selectedItems[0]
                    if (item instanceof LoadMoreItem) {
                        pick.busy = true
                        this.searchAndUpdateItems(item.query, item.nextOffset)
                    } else {
                        resolve(item)
                        pick.dispose()
                    }
                }
            })
            pick.onDidHide(() => {
                resolve(undefined)
                pick.dispose()
            })
        })
        pick.show()
        const item = await pickerPromise
        if (!item) {
            return
        }
        const returnVal = await this.toReturnValue(item)
        return returnVal
    }

    @debounce(500)
    async searchAndUpdateItems(query: string, offset: number): Promise<void> {
        let data: SearchResult<TSearchResultEntry>
        try {
            data = await this.search(query, offset)
        } catch (e) {
            console.error(e)
            window.showErrorMessage(e.message)
            return
        } finally {
            this.quickpick.busy = false
        }

        const resultItems: TResultItem[] = offset === 0 ? [] : this.items.slice()
        resultItems.push(...data.results.map(this.toItem))
        this.items = resultItems.slice()
        
        const items = resultItems as (TResultItem | LoadMoreItem)[]
        if (data.next_offset < data.total) {
            items.push(new LoadMoreItem(query, data.next_offset, data.total))
        }
        
        this.quickpick.items = items
    }

    protected abstract async search(query: string, offset: number): Promise<SearchResult<TSearchResultEntry>>;

    protected abstract toItem(result: TSearchResultEntry): TResultItem;

    protected abstract async toReturnValue(item: TResultItem): Promise<TReturnValue>;
}

interface PodcastItem extends QuickPickItem {
    url: string
}

export class ListenNotesPodcastSearchQuickPick 
        extends ListenNotesSearchQuickPick<PodcastItem, PodcastResult, string> {
    constructor(private cfg: SearchConfiguration, private listenNotes: ListenNotes, 
                log: (msg: string) => void) {
        super('Search podcasts using Listen Notes', log)
    }

    protected async search(query: string, offset: number): Promise<SearchResult<PodcastResult>> {
        // Currently we only want to support sorting episodes, not podcasts, by date.
        const opts = Object.assign({offset: offset}, this.cfg)
        opts.sortByDate = false

        let data = await this.listenNotes.searchPodcasts(query, opts)
        return data
    }

    protected toItem(podcast: PodcastResult): PodcastItem {
        const item = {
            label: podcast.title_original,
            description: `Last episode: ` + toHumanTimeAgo(podcast.latest_pub_date_ms),
            detail: podcast.description_original,
            url: podcast.rss,
            alwaysShow: true            
        }
        return item
    }

    protected async toReturnValue(item: PodcastItem): Promise<string> {
        return item.url
    }
}

interface EpisodeReturnValue {
    feedUrl: string
    enclosureUrl: string
    title: string
}

interface EpisodeItem extends QuickPickItem {
    guid: string
    feedUrl: string
    enclosureUrl: string
    episodeTitle: string
}

export class ListenNotesEpisodeSearchQuickPick
        extends ListenNotesSearchQuickPick<EpisodeItem, EpisodeResult, EpisodeReturnValue> {
    constructor(private cfg: SearchConfiguration, private listenNotes: ListenNotes, 
                log: (msg: string) => void) {
        super('Search episodes using Listen Notes', log)
    }

    protected async search(query: string, offset: number): Promise<SearchResult<EpisodeResult>> {
        const opts = Object.assign({offset: offset}, this.cfg)
        let data = await this.listenNotes.searchEpisodes(query, opts)
        return data
    }

    protected toItem(episode: EpisodeResult): EpisodeItem {
        const item = {
            label: episode.title_original,
            description: episode.description_original,
            detail: toHumanDuration(episode.audio_length_sec) +
                ' | ' + toHumanTimeAgo(episode.pub_date_ms) +
                ' | ' + episode.podcast_title_original,
            episodeTitle: episode.title_original,
            guid: episode.id,
            feedUrl: episode.rss,
            enclosureUrl: episode.audio
        }
        return item
    }

    protected async toReturnValue(item: EpisodeItem): Promise<EpisodeReturnValue> {
        return {
            feedUrl: item.feedUrl!,
            enclosureUrl: item.enclosureUrl!,
            title: item.episodeTitle!
        }
    }
}