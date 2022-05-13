# WoW Lua Error Debugger for Visual Studio Code

A debugger which allows loading Lua errors from WoW into VSCode to allow for looking through the error alongside the code for easier debugging.

This extension is heavily inspired by [local-lua-debugger-vscode](https://github.com/tomblind/local-lua-debugger-vscode) and licensed under the same MIT license.

---
## Features

The specific feature set varies based on the error parser being used. The following parsers are implemented:

### TradeSkillMaster

Loads TradeSkillMaster errors with support for stack frames and local variables.

---
## Usage

To load a crash, simply add the entire error message into a `crash.txt` file in the root of your directory, and create a `launch.json`:
```json
{
  "configurations": [
    {
      "type": "lua-local",
      "request": "launch",
      "name": "Debug",
      "crashFile": "crash.txt",
      "verbose": true
    }
  ]
}
```

---
## Additional Configuration Options
#### `crashfile`

The path to the crashfile to load in the debugger relative to the root of your workspace. This defaults to `crash.txt`.

#### `verbose`

Enable verbose output from the debugger for help when trying to debug issues with the debugger itself.
