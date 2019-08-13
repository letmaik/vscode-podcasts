// Plays audio using command-line players to work-around VS Code's limited native nodejs package support.

import * as path from 'path'
import * as fs from 'fs'
import {EOL} from 'os'
import {platform} from 'process'
import * as findExec from 'find-exec'
import {spawn, ChildProcess, SpawnOptions} from 'child_process'

import { EventEmitter } from 'vscode';
import { getAudioDuration } from './util';

const IS_WINDOWS = platform === 'win32'

// players with MP3 support
const PLAYERS = [
  // bundled = player is shipped by us
  // external = player needs to be installed, e.g. via system package manager
  // system = player ships with the operating system, no need to install
  // offset = start position can be given as CLI argument
  // interactive = can be controlled via redirected stdin, e.g. seeking, pausing
  // status line = outputs a status line with the current playing position
  'powershell', // Windows [bundled, offset, interactive (pause, seek, speed), status line]
  'mplayer', // typically Linux [external, offset, interactive (pause, seek, speed), status line]
  'play', // typically Linux [external, offset]
  'mpg123', // typically Linux [external, status line]
  'mpg321', // typically Linux [external, status line]
  'afplay', // macOS [system]
]

const PLAYER_ARGS = {
  'mplayer': [
    '-msglevel', 'all=0:statusline=5', // output only status lines
    '-input', 'conf=%SUPPORT_DIR%' + path.sep + 'input.conf', // use our own keybindings
    '-af', 'scaletempo', // avoid pitch change when speeding up or slowing down
    '-ss', '%POSITION_S%',
    '%PATH%'
  ],
  'powershell': [
    '-NoProfile',
    '-ExecutionPolicy', 'Unrestricted',
    '-File', '%SUPPORT_DIR%' + path.sep + 'play.ps1',
    '-inputConfigPath', '%SUPPORT_DIR%' + path.sep + 'input.conf',
    '-ss', '%POSITION_S%',
    '%PATH%'
  ],
  'play': [
    '%PATH%',
    'trim', '%POSITION_HHMMSS%'
  ],
  'mpg123': [
    '-v',
    '%PATH%'
  ],
  'mpg321': [
    '-v',
    '%PATH%'
  ],
}

export enum ShellPlayerCommand {
  PAUSE,
  SPEEDUP,
  SLOWDOWN,
  SKIP_FORWARD,
  SKIP_BACKWARD,
  STATUS
}

type CommandMap = {[cmd in ShellPlayerCommand]?: string}

// see extra/input.conf
const MPLAYER_COMMANDS: CommandMap = {
  [ShellPlayerCommand.PAUSE]: 'p',
  [ShellPlayerCommand.SPEEDUP]: ']',
  [ShellPlayerCommand.SLOWDOWN]: '[',
  [ShellPlayerCommand.SKIP_FORWARD]: 'l',
  [ShellPlayerCommand.SKIP_BACKWARD]: 'k',
}

const POWERSHELL_COMMANDS: CommandMap = Object.assign({
  [ShellPlayerCommand.STATUS]: 's'
}, MPLAYER_COMMANDS)

const PLAYER_COMMANDS: {[player: string]: CommandMap} = {
  'mplayer': MPLAYER_COMMANDS,
  'powershell': POWERSHELL_COMMANDS
}

type CommandInfoMap = {[cmd in ShellPlayerCommand]?: number}

const MPLAYER_COMMAND_INFO: CommandInfoMap = {
  [ShellPlayerCommand.SPEEDUP]: 0.1,
  [ShellPlayerCommand.SLOWDOWN]: -0.1,
  [ShellPlayerCommand.SKIP_FORWARD]: 30,
  [ShellPlayerCommand.SKIP_BACKWARD]: -15,
}

const PLAYER_COMMAND_INFO: {[player: string]: CommandInfoMap} = {
  'mplayer': MPLAYER_COMMAND_INFO,
  'powershell': MPLAYER_COMMAND_INFO
}

// A:  52.5 (52.4) of 1863.0 (31:03.0)  0.0%
const MPLAYER_STATUS_REGEX = /A:\s+(?<elapsed>[\d\.]+)\s+/

const PLAYER_STATUS_REGEX: {[player: string]: RegExp} = {
  'mplayer': MPLAYER_STATUS_REGEX,
  'powershell': MPLAYER_STATUS_REGEX,

  // > 1856+2513  00:44.54+01:00.31 --- 100=100 320 kb/s  960 B acc    0 clip p+0.00
  // TODO add mpg123 status line regex
  //'mpg123': //

  // Frame#   334 [ 4035], Time: 00:08.01 [01:36.83],
  // TODO add mpg321 status line regex
  // 'mpg321': //
}

export interface ShellPlayerOptions {
  playerPath?: string
  supportDir: string
}

export enum ShellPlayerStatus {
  PLAYING,
  PAUSED,
  STOPPED
}

export class ShellPlayer {
  private _onStatusChange = new EventEmitter<ShellPlayerStatus>()
  onStatusChange = this._onStatusChange.event

  private _status = ShellPlayerStatus.STOPPED

  private playerPath: string
  private playerName: string // player filename without extension, e.g. 'mplayer'
  private supportDir: string

  private process: ChildProcess | undefined

  public duration: number
  private startPosition: number // s
  private currentPositionFromStatus: number | undefined // s
  private startUnixTimestamp: number // ms
  private stopUnixTimestamp: number | undefined // ms

  constructor(opts: ShellPlayerOptions, private log: (msg: string) => void) {
    this.supportDir = opts.supportDir
    this.setPlayerPath(opts.playerPath)
  }
  
  private setStatus(v: ShellPlayerStatus) {
    this._status = v
    this._onStatusChange.fire(v)
  }

  get status() {
    return this._status
  }  

  setPlayerPath(playerPath?: string) {
    if (playerPath) {
      if (fs.existsSync(playerPath) || findExec([playerPath])) {
        this.playerPath = playerPath
      } else {
        throw new Error(`Player "${playerPath}" not found`)
      }
    } else {
      this.playerPath = findExec(PLAYERS)
      if (!this.playerPath) {
        throw new Error(`No audio player found, tried: ${PLAYERS}`)
      }
    }
    this.playerName = path.basename(this.playerPath, path.extname(this.playerPath))
    this.log(`Player: ${this.playerPath}`)
    if (!this.supportsStartOffset()) {
      this.log(`NOTE: ${this.playerPath} only supports playing from the start of an audio file`)
    }
  }

  supportsStartOffset() {
    return PLAYER_ARGS[this.playerName] !== undefined
  }

  supportsCommands() {
    return PLAYER_COMMANDS[this.playerName] !== undefined
  }

  supportsStatusCommand() {
    return this.supportsCommands() && PLAYER_COMMANDS[this.playerName][ShellPlayerCommand.STATUS] !== undefined
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

  async play(audioPath: string, startPosition: number, duration: number | undefined, onError: (e: Error) => void): Promise<void> {
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

    if (!this.playerPath){
      throw new Error("Couldn't find a suitable audio player")
    }

    if (!this.supportsStartOffset() && startPosition != 0) {
      throw new Error(`${this.playerName} does not support playing from arbitrary positions`)
    }

    if (duration) {
      this.duration = duration
    } else {
      // TODO allow to fail and provide fallbacks
      this.log(`Determining total duration`)
      this.duration = await getAudioDuration(audioPath)
    }

    this.startPosition = startPosition
    this.currentPositionFromStatus = undefined
    this.startUnixTimestamp = Date.now()
    this.stopUnixTimestamp = undefined

    const args = this.getPlayerArgs(audioPath, startPosition)
    this.log(`Running ${this.playerPath} ${args.join(' ')}`)

    if (!this.supportsStatusCommand()) {
      this.setStatus(ShellPlayerStatus.PLAYING)
    }

  
    const process = spawn(this.playerPath, args, options)
    if (!process) {
      throw new Error("Unable to spawn process with " + this.playerPath)
    }
    this.process = process

    const logOutputLines = (data: string) => {
      const lines = data.split(EOL)
      for (let line of lines) {
        line = line.trimRight()
        if (line) {
          this.log(`${this.playerName}: ${line}`)
        }
      }
    }

    process.stdout.setEncoding('utf8')
    process.stdout.on('data', (data: string) => {
      if (!this.extractStatus(data)) {
        logOutputLines(data)
      }
    })

    process.stderr.setEncoding('utf8')
    process.stderr.on('data', logOutputLines)

    let statusCommandIntervalId: NodeJS.Timeout | undefined

    process.on('close', (code, signal) => {
      if (!this.stopUnixTimestamp) {
        this.stopUnixTimestamp = Date.now()
      }
      if (statusCommandIntervalId) {
        clearInterval(statusCommandIntervalId)
      }
      this.setStatus(ShellPlayerStatus.STOPPED)
      if (!process!.killed && code != 0) {
        onError(new Error(`${this.playerName} terminated unexpectedly with exit code ${code}`))
      }
    })

    if (this.supportsStatusCommand()) {
      this.sendCommand(ShellPlayerCommand.STATUS)
      statusCommandIntervalId = setInterval(() => {
        this.sendCommand(ShellPlayerCommand.STATUS)
      }, 1000)
    }
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
    const sendEvent = !this.currentPositionFromStatus
    this.currentPositionFromStatus = parseFloat(matches.groups!['elapsed'])
    if (sendEvent) {
      this.setStatus(ShellPlayerStatus.PLAYING)
    }
    return true
  }

  sendCommand(cmd: ShellPlayerCommand) {
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
    if (cmd != ShellPlayerCommand.STATUS) {
      this.log(`Command: ${ShellPlayerCommand[cmd]}`)
    }
    if (cmd == ShellPlayerCommand.PAUSE) {
      this.setStatus(this.status == ShellPlayerStatus.PLAYING 
        ? ShellPlayerStatus.PAUSED 
        : ShellPlayerStatus.PLAYING)
    }
    this.process.stdin.write(cmds[cmd])
  }

  getCommandInfo(cmd: ShellPlayerCommand): number {
    const infos = PLAYER_COMMAND_INFO[this.playerName]
    if (!infos) {
      throw new Error(`No command infos found for ${this.playerName}`)
    }
    const info = infos[cmd]
    if (info === undefined) {
      throw new Error(`No command info found for ${ShellPlayerCommand[cmd]} (${this.playerName})`)
    }
    return info
  }

  stop() {
    if (!this.process) {
      throw new Error('stop() must be called after start()')
    }
    this.log('Stopping player')
    this.stopUnixTimestamp = Date.now()
    this.process.kill()
    this.process = undefined
  }

  get position() {
    if (this.currentPositionFromStatus) {
      return this.currentPositionFromStatus
    }
    const current = this.stopUnixTimestamp ? this.stopUnixTimestamp : Date.now()
    const elapsed = this.startPosition + (current - this.startUnixTimestamp) / 1000
    if (elapsed > this.duration) {
      return this.duration
    } else {
      return elapsed
    }
  }
}
