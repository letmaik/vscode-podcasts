// Plays audio using command-line players to work-around VS Code's limited native nodejs package support.

import * as findExec from 'find-exec'
import {spawn, ChildProcess, SpawnOptions} from 'child_process'

import mp3Duration = require('./3rdparty/mp3-duration.js')

const PLAYERS = [
                 'powershell', // Windows
                 'mplayer', // typically Linux
                 'play', // typically Linux
                 'aplay', // Linux, built-in, no support for start position
                 'mpg123', // typically Linux, no support for start position in seconds (only frames)
                 'mpg321', // typically Linux, no support for start position in seconds (only frames)
                 'afplay', // macOS, built-in, no support for start position
                 'omxplayer', // Raspberry PI
                ]

const PLAYER_ARGS = {
  'mplayer': ['-ss', '%POSITION_S%', '%PATH%'],
  'play': ['%PATH%', 'trim', '%POSITION_HHMMSS%'],
  'omxplayer': ['--pos', '%POSITION_HHMMSS%', '%PATH%'],
  'powershell': ['-Command',
    '$ErrorActionPreference = "Stop";' +
    'Add-Type -AssemblyName PresentationCore;' +
    '$mediaPlayer = New-Object System.Windows.Media.MediaPlayer;' +
    '$mediaPlayer.Open("%PATH%");' +
    '$mediaPlayer.Position = [System.TimeSpan]::FromSeconds(%POSITION_S%);' +
    '$mediaPlayer.Play();' +
    'Start-Sleep -Seconds %REMAINING_S%;'
  ]
}


export interface Options {
  players?: string[]
  player?: string
}

export class Player {
  private player: string
  private process: ChildProcess | undefined

  private durationCache = new Map<string, number>()
  private duration: number
  private startPosition: number // s
  private startUnixTimestamp: number // ms

  constructor(opts: Options, private log: (msg: string) => void) {
    let players = opts && opts.players ? opts.players : PLAYERS
    this.player = opts && opts.player ? opts.player : findExec(players)
    if (!PLAYER_ARGS[this.player]) {
      this.log(`NOTE: ${this.player} only supports playing from the start of an audio file`)
    }
  }

  async getDuration(path: string): Promise<number> {
    const duration = await mp3Duration(path)
    if (duration == 0) {
      throw new Error('Unable to extract audio duration')
    }
    if (!this.durationCache.has(path)) {
      this.durationCache.set(path, duration)
    }
    return this.durationCache.get(path)!
  }

  async play(path: string, startPosition: number, onError: (e: Error) => void): Promise<void> {
    let options: SpawnOptions = {
      stdio: ['ignore', 'pipe', 'pipe']
    }

    if (this.process) {
      this.stop()
    }

    if (!path) {
      throw new Error("No audio file specified")
    }

    if (!this.player){
      throw new Error("Couldn't find a suitable audio player")
    }

    this.duration = await this.getDuration(path)
    const remaining = this.duration - startPosition
    const startPositionHHMMSS = new Date(startPosition * 1000).toISOString().substr(11, 8);

    const args: string[] = []
    if (PLAYER_ARGS[this.player]) {
      for (let arg of PLAYER_ARGS[this.player]) {
        arg = arg.replace('%PATH%', path)
        arg = arg.replace('%POSITION_S%', startPosition)
        arg = arg.replace('%POSITION_HHMMSS%', startPositionHHMMSS)
        arg = arg.replace('%REMAINING_S%', remaining)
        args.push(arg)
      }
    } else {
      args.push(path)
    }
    this.log(`Running ${this.player} ${args.join(' ')}`)

    this.startUnixTimestamp = Date.now()
    this.process = spawn(this.player, args, options)
    if (!this.process) {
      throw new Error("Unable to spawn process with " + this.player)
    }

    this.process.stdout.setEncoding('utf8');
    this.process.stdout.on('data', data => {
      this.log(`${this.player}: ${data}`);
    });

    this.process.stderr.setEncoding('utf8');
    this.process.stderr.on('data', data => {
      this.log(`${this.player}: ${data}`);
    });

    this.process.on('close', (code, signal) => {
      if (!this.process!.killed && code != 0) {
        onError(new Error(`${this.player} terminated unexpectedly with exit code ${code}`))
      }
    })

    this.startPosition = startPosition
  }

  stop(): number {
    if (!this.process) {
      throw new Error('stop() must be called after start()')
    }
    this.process.kill()
    const elapsed = this.startPosition + (Date.now() - this.startUnixTimestamp) / 1000
    if (elapsed > this.duration) {
      return -1
    } else {
      return elapsed
    }
  }
}
