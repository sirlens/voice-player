# voice-player

Claude Code mod that reads every answer aloud, with a small player above the prompt. Windows only.

## Requirements

- Windows 10/11
- [.NET 10 SDK](https://dotnet.microsoft.com/download/dotnet/10.0) (the server compiles on first run)

## Install

```
/plugin install voice-player --marketplace sirlens/voice-player
```

## Use

Buttons: click, or `ctrl+x tab` then the key.

| Key | Action |
|---|---|
| `h` / `l` | Previous / next sentence |
| `p` | Pause / resume |
| `s` | Stop |
| `r` | Repeat last answer |
| `j` / `k` | Slower / faster |
| `o` | On / off |

Command: `/voice-player pause | resume | stop | next | prev | again [n] | rate <-10..10> | on | off | log`
