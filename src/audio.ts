// Plays audio using command-line players to work-around VS Code's limited native nodejs package support.

import * as path from 'path'
import * as fs from 'fs'
import {platform} from 'process'
import * as findExec from 'find-exec'
import {spawn, ChildProcess, SpawnOptions} from 'child_process'

import mp3Duration = require('./3rdparty/mp3-duration.js')

const IS_WINDOWS = platform === 'win32'

const PLAYERS = [
  'powershell', // Windows
  'mplayer', // typically Linux, supports interactive control via stdin
  'play', // typically Linux
  'aplay', // Linux, built-in, no support for start position
  'mpg123', // typically Linux, no support for start position in seconds (only frames)
  'mpg321', // typically Linux, no support for start position in seconds (only frames)
  'afplay', // macOS, built-in, no support for start position
  'omxplayer', // Raspberry PI
]

const PLAYER_ARGS = {
  'mplayer': [
    '-msglevel', 'all=0:statusline=5', // output only status lines
    '-input', 'conf=%SUPPORT_DIR%' + path.sep + 'input.conf', // use our own keybindings
    '-af', 'scaletempo', // avoid pitch change when speeding up or slowing down
    '-ss', '%POSITION_S%',
    '%PATH%'
  ],
  'play': [
    '%PATH%',
    'trim', '%POSITION_HHMMSS%'
  ],
  'omxplayer': [
    '--pos', '%POSITION_HHMMSS%',
    '%PATH%'
  ],
  'powershell': [
    '%SUPPORT_DIR%' + path.sep + 'play.ps1',
    '-inputConfigPath', '%SUPPORT_DIR%' + path.sep + 'input.conf',
    '-ss', '%POSITION_S%',
    '%PATH%']
}

export enum Command {
  PAUSE,
  SPEEDUP,
  SLOWDOWN,
  SKIP_FORWARD,
  SKIP_BACKWARD,
  STATUS
}

// see extra/input.conf
const MPLAYER_COMMANDS: {[cmd in Command]: string | undefined} = {
  [Command.PAUSE]: 'p',
  [Command.SPEEDUP]: ']',
  [Command.SLOWDOWN]: '[',
  [Command.SKIP_FORWARD]: 'l',
  [Command.SKIP_BACKWARD]: 'k',
  [Command.STATUS]: undefined // status is printed continuously
}

const POWERSHELL_COMMANDS = Object.assign({}, MPLAYER_COMMANDS)
POWERSHELL_COMMANDS[Command.STATUS] = 's'

const PLAYER_COMMANDS: {[player: string]: {[cmd in Command]: string | undefined}} = {
  'mplayer': MPLAYER_COMMANDS,
  'powershell': POWERSHELL_COMMANDS
}

// A:  52.5 (52.4) of 1863.0 (31:03.0)  0.0%
const MPLAYER_STATUS_REGEX = /A:\s+(?<elapsed>[\d\.]+)\s+/

const PLAYER_STATUS_REGEX: {[player: string]: RegExp} = {
  'mplayer': MPLAYER_STATUS_REGEX,
  'powershell': MPLAYER_STATUS_REGEX,
}

export interface Options {
  player?: string
  supportDir: string
}

export class Player {
  private player: string
  private playerName: string
  private supportDir: string

  private process: ChildProcess | undefined
  private statusCommandIntervalId: NodeJS.Timeout

  private durationCache = new Map<string, number>()
  private duration: number
  private startPosition: number // s
  private currentPosition: number | undefined // s
  private startUnixTimestamp: number // ms

  constructor(opts: Options, private log: (msg: string) => void) {
    this.supportDir = opts.supportDir
    this.setPlayer(opts.player)
  }

  setPlayer(player?: string) {
    if (player) {
      if (fs.existsSync(player) || findExec([player])) {
        this.player = player
      } else {
        throw new Error(`Player "${player}" not found`)
      }
    } else {
      this.player = findExec(PLAYERS)
      if (!this.player) {
        throw new Error(`No audio player found, tried: ${PLAYERS}`)
      }
    }
    this.playerName = path.basename(this.player, path.extname(this.player))
    this.log(`Player: ${this.player}`)
    if (!this.supportsStartOffset()) {
      this.log(`NOTE: ${this.player} only supports playing from the start of an audio file`)
    }
  }

  supportsStartOffset() {
    return PLAYER_ARGS[this.playerName] !== undefined
  }

  supportsCommands() {
    return PLAYER_COMMANDS[this.playerName] !== undefined
  }

  supportsStatusCommand() {
    return this.supportsCommands() && PLAYER_COMMANDS[this.playerName][Command.STATUS] !== undefined
  }
 
  private getPlayerArgs(audioPath: string, startPosition: number) {
    let args: string[] = []
    if (!PLAYER_ARGS[this.playerName]) {
      args.push(audioPath)
    } else {
      const startPositionHHMMSS = new Date(startPosition * 1000).toISOString().substr(11, 8);
      for (let arg of PLAYER_ARGS[this.playerName]) {
        arg = arg.replace('%PATH%', audioPath)
        let supportDir = this.supportDir
        if (this.playerName == 'mplayer' && IS_WINDOWS) {
          // http://betterlogic.com/roger/2011/07/mplayer-input-conf-windows/
          // Needs to be an absolute path without drive letter.
          supportDir = supportDir.split(':')[1]
        }
        arg = arg.replace('%SUPPORT_DIR%', supportDir)
        arg = arg.replace('%POSITION_S%', startPosition)
        arg = arg.replace('%POSITION_HHMMSS%', startPositionHHMMSS)
        args.push(arg)
      }
    }
    return args
  }

  async getDuration(audioPath: string): Promise<number> {
    const duration = await mp3Duration(audioPath)
    if (duration == 0) {
      throw new Error('Unable to extract audio duration')
    }
    if (!this.durationCache.has(audioPath)) {
      this.durationCache.set(audioPath, duration)
    }
    return this.durationCache.get(audioPath)!
  }

  async play(audioPath: string, startPosition: number, onError: (e: Error) => void): Promise<void> {
    let options: SpawnOptions = {
      stdio: 'pipe',
      // Not generally needed, but required for mplayer on Windows to eat
      // our custom keybinding config file. See getPlayerArgs() for details.
      cwd: this.supportDir
    }

    if (this.process) {
      this.stop()
    }

    if (!audioPath) {
      throw new Error("No audio file specified")
    }

    if (!this.player){
      throw new Error("Couldn't find a suitable audio player")
    }

    this.duration = await this.getDuration(audioPath)
    const args = this.getPlayerArgs(audioPath, startPosition)
    this.log(`Running ${this.player} ${args.join(' ')}`)

    this.startUnixTimestamp = Date.now()
    this.process = spawn(this.player, args, options)
    if (!this.process) {
      throw new Error("Unable to spawn process with " + this.player)
    }

    this.process.stdout.setEncoding('utf8')
    this.process.stdout.on('data', data => {
      if (!this.extractStatus(data)) {
        this.log(`${this.playerName}: ${data}`)
      }
    });

    this.process.stderr.setEncoding('utf8')
    this.process.stderr.on('data', data => {
      this.log(`${this.playerName}: ${data}`)
    });

    this.process.on('close', (code, signal) => {
      clearInterval(this.statusCommandIntervalId)
      if (!this.process!.killed && code != 0) {
        onError(new Error(`${this.playerName} terminated unexpectedly with exit code ${code}`))
      }
    })

    if (this.supportsStatusCommand()) {
      this.statusCommandIntervalId = setInterval(() => {
        this.sendCommand(Command.STATUS)
      }, 1000)
    }

    this.startPosition = startPosition
  }

  private extractStatus(line: string) {
    const re = PLAYER_STATUS_REGEX[this.playerName]
    if (!re) {
      return false
    }
    
    const matches = line.match(re)
    if (!matches) {
      return false
    }
    this.currentPosition = parseFloat(matches.groups!['elapsed'])
    return true
  }

  sendCommand(cmd: Command) {
    if (!this.process) {
      return
    }
    if (!this.supportsCommands()) {
      throw new Error(`${this.playerName} cannot be controlled interactively`)
    }
    const cmds = PLAYER_COMMANDS[this.playerName]
    if (!cmds[cmd]) {
      throw new Error(`${this.playerName} does not support the ${cmd} command`)
    }
    this.process.stdin.write(cmds[cmd])
  }

  stop(): number {
    if (!this.process) {
      throw new Error('stop() must be called after start()')
    }
    this.process.kill()
    this.process = undefined
    const elapsed = this.startPosition + (Date.now() - this.startUnixTimestamp) / 1000
    if (elapsed > this.duration) {
      return -1
    } else {
      return elapsed
    }
  }
}
