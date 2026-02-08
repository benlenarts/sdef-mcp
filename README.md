# sdef-mcp

MCP server that gives any MCP client fine-grained access to macOS AppleScript dictionaries (SDEF). Instead of dumping an entire app dictionary into context, the client can progressively drill into just the suites, commands, classes, and properties it needs.

## Why

Most macOS desktop apps are scriptable via AppleScript, but LLMs don't know their APIs. This MCP lets any client efficiently discover the scripting capabilities of any app on your Mac — browsing suites, looking up commands and classes on demand — so it can write correct AppleScript without guessing.

## Requirements

- macOS (uses the `sdef` command and `mdfind`)
- Node.js 18+

## Setup

### Claude Code

```bash
claude mcp add sdef-reader -- node /path/to/sdef-mcp/server/index.js
```

### Claude Desktop

Build the `.mcpb` bundle, then drag and drop it onto the Extensions section in Claude Desktop settings:

```bash
./build.sh
```

## Tools

| Tool | Purpose | Token cost |
|------|---------|------------|
| `list_scriptable_apps` | Find scriptable apps on the system | Low |
| `get_app_suites` | Suite names + descriptions + counts | Low |
| `get_suite_detail` | All commands/classes/enums in a suite | Medium |
| `get_command` | Full command signature + params + types | Low |
| `get_class` | Properties, elements, inheritance | Low-Med |
| `get_enumeration` | All values for an enum type | Low |
| `search_dictionary` | Keyword search across everything | Varies |

## Typical flow

```
1. get_app_suites("Mail")
   → see suites: Standard Suite, Mail Suite, ...

2. get_suite_detail("Mail", "Mail Suite")
   → see all commands and classes at a glance

3. get_class("Mail", "message")
   → full property list, elements, what commands it responds to

4. get_command("Mail", "send")
   → exact parameter signature
```

## Output format

Compact plain text optimized for LLM consumption. Example:

```
COMMAND: make  [Standard Suite]
  Create a new object
  Direct param: type [class name]
  Params:
    new: type — the class of the new object
    at: location specifier [optional] — the location at which to insert
    with data: any [optional] — the initial data
    with properties: record [optional] — the initial property values
  Returns: specifier — to the new object
```

```
CLASS: tab  [Safari Suite]
  Inherits: item
  Plural: tabs
  A tab in a window
  Properties:
    source: text — the URL of the page currently loaded
    URL: text — the URL of the page currently loaded
    index: integer [r] — the index of the tab
    text: text [r] — the text of the page currently loaded
    visible: boolean [r] — whether the tab is currently visible
    name: text [r] — the name of the tab
  Elements: (none)
  Responds to: close, print, save
```
