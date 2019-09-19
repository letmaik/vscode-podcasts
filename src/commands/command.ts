export interface Command {
    COMMAND: string

    run(...args: any[])
}