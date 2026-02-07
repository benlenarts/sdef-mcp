#!/usr/bin/env node
/**
 * sdef-mcp: MCP server for reading macOS AppleScript dictionaries (SDEF).
 *
 * Provides fine-grained, token-efficient access to app scripting definitions
 * so AI assistants can write accurate AppleScript without hallucinating APIs.
 *
 * Tools:
 *   list_scriptable_apps  — discover what's scriptable
 *   get_app_suites        — suite overview for an app
 *   get_suite_detail      — commands, classes, enums in a suite
 *   get_command           — full command signature
 *   get_class             — full class detail (props, elements, inheritance)
 *   get_enumeration       — enum values
 *   search_dictionary     — keyword search across an app's dictionary
 */

import { execFileSync } from "node:child_process";
import { readdirSync, statSync, existsSync } from "node:fs";
import { join, basename } from "node:path";
import { homedir } from "node:os";

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

import { XMLParser } from "fast-xml-parser";

// ---------------------------------------------------------------------------
// XML parser config
// ---------------------------------------------------------------------------

const ARRAY_TAGS = new Set([
  "suite",
  "command",
  "class",
  "class-extension",
  "parameter",
  "property",
  "element",
  "enumeration",
  "enumerator",
  "responds-to",
  "type",
]);

const xmlParser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  isArray: (tagName) => ARRAY_TAGS.has(tagName),
});

// ---------------------------------------------------------------------------
// SDEF XML Parser
// ---------------------------------------------------------------------------

class SDEFParser {
  constructor(xmlString) {
    const parsed = xmlParser.parse(xmlString);
    const root = parsed.dictionary;
    if (!root) {
      throw new Error("Malformed SDEF XML: no <dictionary> root element");
    }
    this.title = root["@_title"] || "";
    this.suites = [];
    this._parse(root);
  }

  static _resolveType(el) {
    if (el["@_type"]) {
      let t = el["@_type"] || "any";
      if (el["@_list"] === "yes") t = `list of ${t}`;
      return t;
    }
    const typeEls = el.type;
    if (typeEls && typeEls.length > 0) {
      const parts = [];
      for (const t of typeEls) {
        let name = t["@_type"] || "any";
        if (t["@_list"] === "yes") name = `list of ${name}`;
        parts.push(name);
      }
      return parts.join(" | ");
    }
    return "any";
  }

  _parse(root) {
    for (const suiteEl of root.suite || []) {
      const suite = {
        name: suiteEl["@_name"] || "",
        code: suiteEl["@_code"] || "",
        description: suiteEl["@_description"] || "",
        commands: [],
        classes: [],
        enumerations: [],
      };
      for (const cmdEl of suiteEl.command || []) {
        suite.commands.push(this._parseCommand(cmdEl));
      }
      for (const clsEl of suiteEl.class || []) {
        suite.classes.push(this._parseClass(clsEl));
      }
      for (const extEl of suiteEl["class-extension"] || []) {
        const cls = this._parseClass(extEl);
        cls.is_extension = true;
        suite.classes.push(cls);
      }
      for (const enumEl of suiteEl.enumeration || []) {
        suite.enumerations.push(this._parseEnum(enumEl));
      }
      this.suites.push(suite);
    }
  }

  _parseCommand(el) {
    const cmd = {
      name: el["@_name"] || "",
      code: el["@_code"] || "",
      description: el["@_description"] || "",
      direct_parameter: null,
      parameters: [],
      result: null,
    };

    const dp = el["direct-parameter"];
    if (dp) {
      cmd.direct_parameter = {
        type: SDEFParser._resolveType(dp),
        description: dp["@_description"] || "",
        optional: dp["@_optional"] === "yes",
      };
    }

    for (const p of el.parameter || []) {
      cmd.parameters.push({
        name: p["@_name"] || "",
        code: p["@_code"] || "",
        type: SDEFParser._resolveType(p),
        description: p["@_description"] || "",
        optional: p["@_optional"] === "yes",
      });
    }

    const res = el.result;
    if (res) {
      cmd.result = {
        type: SDEFParser._resolveType(res),
        description: res["@_description"] || "",
      };
    }
    return cmd;
  }

  _parseClass(el) {
    const cls = {
      name: el["@_name"] || "",
      code: el["@_code"] || "",
      description: el["@_description"] || "",
      inherits: el["@_inherits"] || "",
      plural: el["@_plural"] || "",
      properties: [],
      elements: [],
      responds_to: [],
      is_extension: false,
    };

    for (const p of el.property || []) {
      cls.properties.push({
        name: p["@_name"] || "",
        code: p["@_code"] || "",
        type: SDEFParser._resolveType(p),
        access: p["@_access"] || "rw",
        description: p["@_description"] || "",
      });
    }

    for (const e of el.element || []) {
      cls.elements.push({
        type: SDEFParser._resolveType(e),
        access: e["@_access"] || "rw",
      });
    }

    for (const rt of el["responds-to"] || []) {
      const cmdName = rt["@_command"] || rt["@_name"] || "";
      if (cmdName) cls.responds_to.push(cmdName);
    }

    return cls;
  }

  _parseEnum(el) {
    const enm = {
      name: el["@_name"] || "",
      code: el["@_code"] || "",
      values: [],
    };
    for (const v of el.enumerator || []) {
      enm.values.push({
        name: v["@_name"] || "",
        code: v["@_code"] || "",
        description: v["@_description"] || "",
      });
    }
    return enm;
  }
}

// ---------------------------------------------------------------------------
// App discovery
// ---------------------------------------------------------------------------

function findAppPath(name) {
  // Try mdfind first (fast, indexed)
  try {
    const result = execFileSync(
      "mdfind",
      [
        `kMDItemDisplayName == '${name}' && kMDItemContentType == 'com.apple.application-bundle'`,
      ],
      { encoding: "utf8", timeout: 10000 }
    );
    const paths = result
      .trim()
      .split("\n")
      .filter((p) => p.trim());
    if (paths.length > 0) {
      for (const p of paths) {
        if (
          p.startsWith("/Applications") ||
          p.startsWith("/System/Applications")
        ) {
          return p;
        }
      }
      return paths[0];
    }
  } catch {
    // fall through to directory scan
  }

  // Fallback: check common directories (including subdirectories)
  for (const base of [
    "/Applications",
    "/System/Applications",
    join(homedir(), "Applications"),
  ]) {
    const candidate = join(base, `${name}.app`);
    if (existsSync(candidate)) return candidate;

    // Search subdirectories (e.g. /Applications/Setapp/Bike.app)
    if (!existsSync(base)) continue;
    try {
      for (const entry of readdirSync(base, { withFileTypes: true })) {
        if (entry.isDirectory() && !entry.name.endsWith(".app")) {
          const nested = join(base, entry.name, `${name}.app`);
          if (existsSync(nested)) return nested;
        }
      }
    } catch {
      // ignore permission errors
    }
  }

  return null;
}

function getSdefXml(appPath) {
  try {
    return execFileSync("sdef", [appPath], {
      encoding: "utf8",
      timeout: 30000,
    });
  } catch (err) {
    throw new Error(
      `Could not get SDEF for ${appPath}. ` +
        `The app may not be scriptable. ${err.message}`
    );
  }
}

// ---------------------------------------------------------------------------
// Cache (in-memory, per-process)
// ---------------------------------------------------------------------------

const sdefCache = new Map();

function getParser(appName) {
  if (!sdefCache.has(appName)) {
    const appPath = findAppPath(appName);
    if (!appPath) {
      throw new Error(
        `App '${appName}' not found. ` +
          "Use list_scriptable_apps to see available apps."
      );
    }
    const xml = getSdefXml(appPath);
    sdefCache.set(appName, new SDEFParser(xml));
  }
  return sdefCache.get(appName);
}

// ---------------------------------------------------------------------------
// Plist helper
// ---------------------------------------------------------------------------

function readPlist(plistPath) {
  const json = execFileSync(
    "plutil",
    ["-convert", "json", "-o", "-", plistPath],
    { encoding: "utf8", timeout: 5000 }
  );
  return JSON.parse(json);
}

// ---------------------------------------------------------------------------
// App bundle finder
// ---------------------------------------------------------------------------

function findAppBundles(dir) {
  const results = [];
  if (!existsSync(dir)) return results;

  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return results;
  }

  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.name.endsWith(".app")) {
      results.push(full);
      // Also recurse into .app in case there are nested .app bundles
      // (e.g. /Applications/Utilities is a directory, not an .app)
    } else if (entry.isDirectory()) {
      results.push(...findAppBundles(full));
    }
  }
  return results;
}

// ---------------------------------------------------------------------------
// Formatters — compact, token-efficient plain text
// ---------------------------------------------------------------------------

function fmtSuitesOverview(parser) {
  const lines = [];
  for (const s of parser.suites) {
    const desc = s.description || "\u2014";
    lines.push(`\u25A0 ${s.name}`);
    lines.push(`  ${desc}`);
    lines.push(
      `  ${s.commands.length} commands \u00B7 ` +
        `${s.classes.length} classes \u00B7 ` +
        `${s.enumerations.length} enums`
    );
    lines.push("");
  }
  return lines.join("\n").trimEnd();
}

function fmtSuiteDetail(suite) {
  const lines = [`${"═".repeat(3)} ${suite.name} ${"═".repeat(3)}`];
  if (suite.description) lines.push(suite.description);
  lines.push("");

  if (suite.commands.length > 0) {
    lines.push("COMMANDS:");
    for (const cmd of suite.commands) {
      lines.push(`  ${fmtCommandSignature(cmd)}`);
    }
    lines.push("");
  }

  if (suite.classes.length > 0) {
    lines.push("CLASSES:");
    for (const cls of suite.classes) {
      const inh = cls.inherits ? ` : ${cls.inherits}` : "";
      const ext = cls.is_extension ? " [ext]" : "";
      const desc = cls.description ? ` \u2014 ${cls.description}` : "";
      lines.push(
        `  ${cls.name}${inh}${ext}` +
          ` (${cls.properties.length}p ${cls.elements.length}e)` +
          desc
      );
    }
    lines.push("");
  }

  if (suite.enumerations.length > 0) {
    lines.push("ENUMS:");
    for (const enm of suite.enumerations) {
      const vals = enm.values.map((v) => v.name).join(" | ");
      lines.push(`  ${enm.name}: ${vals}`);
    }
    lines.push("");
  }

  return lines.join("\n").trimEnd();
}

function fmtCommandSignature(cmd) {
  const parts = [cmd.name];
  if (cmd.direct_parameter) {
    const dp = cmd.direct_parameter;
    const opt = dp.optional ? "?" : "";
    parts.push(`<${dp.type}${opt}>`);
  }
  for (const p of cmd.parameters) {
    const opt = p.optional ? "?" : "";
    parts.push(`${p.name}:${p.type}${opt}`);
  }
  if (cmd.result) {
    parts.push(`\u2192 ${cmd.result.type}`);
  }
  const desc = cmd.description ? `  // ${cmd.description}` : "";
  return parts.join(" ") + desc;
}

function fmtCommandDetail(cmd, suiteName = "") {
  let header = `COMMAND: ${cmd.name}`;
  if (suiteName) header += `  [${suiteName}]`;
  const lines = [header];
  if (cmd.description) lines.push(`  ${cmd.description}`);

  if (cmd.direct_parameter) {
    const dp = cmd.direct_parameter;
    const opt = dp.optional ? " [optional]" : "";
    lines.push(`  Direct param: ${dp.type}${opt}`);
    if (dp.description) lines.push(`    ${dp.description}`);
  }

  if (cmd.parameters.length > 0) {
    lines.push("  Params:");
    for (const p of cmd.parameters) {
      const opt = p.optional ? " [optional]" : "";
      const desc = p.description ? ` \u2014 ${p.description}` : "";
      lines.push(`    ${p.name}: ${p.type}${opt}${desc}`);
    }
  }

  if (cmd.result) {
    const desc = cmd.result.description
      ? ` \u2014 ${cmd.result.description}`
      : "";
    lines.push(`  Returns: ${cmd.result.type}${desc}`);
  }

  return lines.join("\n");
}

function fmtClassDetail(cls, suiteName = "") {
  let header = `CLASS: ${cls.name}`;
  if (suiteName) header += `  [${suiteName}]`;
  const lines = [header];
  if (cls.inherits) lines.push(`  Inherits: ${cls.inherits}`);
  if (cls.plural) lines.push(`  Plural: ${cls.plural}`);
  if (cls.is_extension) lines.push("  (class extension)");
  if (cls.description) lines.push(`  ${cls.description}`);

  if (cls.properties.length > 0) {
    lines.push("  Properties:");
    for (const p of cls.properties) {
      const acc = p.access !== "rw" ? ` [${p.access}]` : "";
      const desc = p.description ? ` \u2014 ${p.description}` : "";
      lines.push(`    ${p.name}: ${p.type}${acc}${desc}`);
    }
  }

  if (cls.elements.length > 0) {
    const elems = cls.elements.map((e) => e.type).join(", ");
    lines.push(`  Elements: ${elems}`);
  }

  if (cls.responds_to.length > 0) {
    lines.push(`  Responds to: ${cls.responds_to.join(", ")}`);
  }

  return lines.join("\n");
}

function fmtEnumDetail(enm, suiteName = "") {
  let header = `ENUM: ${enm.name}`;
  if (suiteName) header += `  [${suiteName}]`;
  const lines = [header];
  for (const v of enm.values) {
    const desc = v.description ? ` \u2014 ${v.description}` : "";
    lines.push(`  ${v.name}${desc}`);
  }
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Tool implementations
// ---------------------------------------------------------------------------

function listScriptableApps(searchDir = "/Applications") {
  const scriptable = [];
  const dirsToCheck = [searchDir];
  if (searchDir === "/Applications") {
    dirsToCheck.push("/System/Applications");
    dirsToCheck.push(join(homedir(), "Applications"));
  }

  for (const d of dirsToCheck) {
    const appPaths = findAppBundles(d);
    for (const appPath of appPaths.sort()) {
      const infoPlist = join(appPath, "Contents", "Info.plist");
      if (!existsSync(infoPlist)) continue;
      try {
        const plist = readPlist(infoPlist);
        if (plist.OSAScriptingDefinition || plist.NSAppleScriptEnabled) {
          scriptable.push(basename(appPath, ".app"));
        }
      } catch {
        continue;
      }
    }
  }

  if (scriptable.length === 0) return "No scriptable apps found.";

  const unique = [...new Set(scriptable)].sort();
  return "Scriptable apps:\n" + unique.map((app) => `  ${app}`).join("\n");
}

function getAppSuites(appName) {
  const parser = getParser(appName);
  const title = `Dictionary: ${parser.title || appName}\n\n`;
  return title + fmtSuitesOverview(parser);
}

function getSuiteDetail(appName, suiteName) {
  const parser = getParser(appName);
  for (const suite of parser.suites) {
    if (suite.name.toLowerCase() === suiteName.toLowerCase()) {
      return fmtSuiteDetail(suite);
    }
  }
  const available = parser.suites.map((s) => s.name).join(", ");
  return `Suite '${suiteName}' not found. Available: ${available}`;
}

function getCommand(appName, commandName) {
  const parser = getParser(appName);
  const results = [];
  for (const suite of parser.suites) {
    for (const cmd of suite.commands) {
      if (cmd.name.toLowerCase() === commandName.toLowerCase()) {
        results.push(fmtCommandDetail(cmd, suite.name));
      }
    }
  }
  if (results.length > 0) return results.join("\n\n");

  const allCmds = [
    ...new Set(
      parser.suites.flatMap((s) => s.commands.map((c) => c.name))
    ),
  ].sort();
  return `Command '${commandName}' not found.\nAvailable: ${allCmds.join(", ")}`;
}

function getClass(appName, className) {
  const parser = getParser(appName);
  const results = [];
  for (const suite of parser.suites) {
    for (const cls of suite.classes) {
      if (cls.name.toLowerCase() === className.toLowerCase()) {
        results.push(fmtClassDetail(cls, suite.name));
      }
    }
  }
  if (results.length > 0) return results.join("\n\n");

  const allClasses = [
    ...new Set(
      parser.suites.flatMap((s) => s.classes.map((c) => c.name))
    ),
  ].sort();
  return `Class '${className}' not found.\nAvailable: ${allClasses.join(", ")}`;
}

function getEnumeration(appName, enumName) {
  const parser = getParser(appName);
  const results = [];
  for (const suite of parser.suites) {
    for (const enm of suite.enumerations) {
      if (enm.name.toLowerCase() === enumName.toLowerCase()) {
        results.push(fmtEnumDetail(enm, suite.name));
      }
    }
  }
  if (results.length > 0) return results.join("\n\n");

  const allEnums = [
    ...new Set(
      parser.suites.flatMap((s) => s.enumerations.map((e) => e.name))
    ),
  ].sort();
  return `Enum '${enumName}' not found.\nAvailable: ${allEnums.join(", ")}`;
}

function searchDictionary(appName, query) {
  const parser = getParser(appName);
  const q = query.toLowerCase();
  const hits = [];

  for (const suite of parser.suites) {
    const sn = suite.name;

    for (const cmd of suite.commands) {
      if (
        cmd.name.toLowerCase().includes(q) ||
        (cmd.description || "").toLowerCase().includes(q)
      ) {
        const sig = fmtCommandSignature(cmd);
        hits.push(`  CMD  [${sn}] ${sig}`);
      }
    }

    for (const cls of suite.classes) {
      if (
        cls.name.toLowerCase().includes(q) ||
        (cls.description || "").toLowerCase().includes(q)
      ) {
        const inh = cls.inherits ? ` : ${cls.inherits}` : "";
        hits.push(
          `  CLS  [${sn}] ${cls.name}${inh}` +
            ` (${cls.properties.length}p ${cls.elements.length}e)`
        );
      }

      // Also search within properties
      for (const prop of cls.properties) {
        if (
          prop.name.toLowerCase().includes(q) ||
          (prop.description || "").toLowerCase().includes(q)
        ) {
          const acc = prop.access !== "rw" ? ` [${prop.access}]` : "";
          hits.push(
            `  PROP [${sn}] ${cls.name}.${prop.name}: ${prop.type}${acc}`
          );
        }
      }
    }

    for (const enm of suite.enumerations) {
      if (enm.name.toLowerCase().includes(q)) {
        const vals = enm.values.map((v) => v.name).join(" | ");
        hits.push(`  ENUM [${sn}] ${enm.name}: ${vals}`);
      } else {
        for (const v of enm.values) {
          if (v.name.toLowerCase().includes(q)) {
            const desc = v.description ? ` \u2014 ${v.description}` : "";
            hits.push(`  VAL  [${sn}] ${enm.name}.${v.name}${desc}`);
          }
        }
      }
    }
  }

  if (hits.length === 0) {
    return `No results for '${query}' in ${appName}'s dictionary.`;
  }

  return (
    `Search '${query}' in ${appName} (${hits.length} hits):\n` +
    hits.join("\n")
  );
}

// ---------------------------------------------------------------------------
// MCP Server
// ---------------------------------------------------------------------------

const TOOLS = [
  {
    name: "list_scriptable_apps",
    description:
      "List macOS applications that have AppleScript scripting dictionaries.",
    inputSchema: {
      type: "object",
      properties: {
        search_dir: {
          type: "string",
          description:
            "Directory to search. Defaults to /Applications (also checks /System/Applications).",
          default: "/Applications",
        },
      },
    },
  },
  {
    name: "get_app_suites",
    description:
      "Get a compact overview of all scripting suites in an app. Shows suite names, descriptions, and counts of commands/classes/enums. This is the recommended starting point for exploring an unfamiliar app.",
    inputSchema: {
      type: "object",
      properties: {
        app_name: {
          type: "string",
          description: 'Application name, e.g. "Safari", "Finder", "Mail"',
        },
      },
      required: ["app_name"],
    },
  },
  {
    name: "get_suite_detail",
    description:
      "Get the full contents of a suite — commands (as signatures), classes, and enums. Use get_app_suites first to see which suites are available.",
    inputSchema: {
      type: "object",
      properties: {
        app_name: { type: "string", description: "Application name" },
        suite_name: {
          type: "string",
          description: "Suite name (case-insensitive)",
        },
      },
      required: ["app_name", "suite_name"],
    },
  },
  {
    name: "get_command",
    description:
      "Get full details for a command — parameters, types, result. If the command exists in multiple suites, all definitions are shown.",
    inputSchema: {
      type: "object",
      properties: {
        app_name: { type: "string", description: "Application name" },
        command_name: {
          type: "string",
          description:
            'Command name (case-insensitive), e.g. "make", "close", "save"',
        },
      },
      required: ["app_name", "command_name"],
    },
  },
  {
    name: "get_class",
    description:
      "Get full details for a class — properties, elements, inheritance, responds-to. If the class has extensions in other suites, those are shown too.",
    inputSchema: {
      type: "object",
      properties: {
        app_name: { type: "string", description: "Application name" },
        class_name: {
          type: "string",
          description:
            'Class name (case-insensitive), e.g. "document", "window", "tab"',
        },
      },
      required: ["app_name", "class_name"],
    },
  },
  {
    name: "get_enumeration",
    description: "Get all values for a specific enumeration type.",
    inputSchema: {
      type: "object",
      properties: {
        app_name: { type: "string", description: "Application name" },
        enum_name: {
          type: "string",
          description:
            'Enumeration name (case-insensitive), e.g. "save options", "printing error handling"',
        },
      },
      required: ["app_name", "enum_name"],
    },
  },
  {
    name: "search_dictionary",
    description:
      "Search an app's entire dictionary for commands, classes, properties, or enums matching a keyword. Searches names and descriptions. Useful when you're not sure what suite something is in.",
    inputSchema: {
      type: "object",
      properties: {
        app_name: { type: "string", description: "Application name" },
        query: {
          type: "string",
          description:
            'Search term (case-insensitive), e.g. "tab", "url", "save", "window"',
        },
      },
      required: ["app_name", "query"],
    },
  },
];

const server = new Server(
  { name: "sdef-reader", version: "1.1.0" },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: TOOLS,
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  try {
    let text;
    switch (name) {
      case "list_scriptable_apps":
        text = listScriptableApps(args?.search_dir);
        break;
      case "get_app_suites":
        text = getAppSuites(args.app_name);
        break;
      case "get_suite_detail":
        text = getSuiteDetail(args.app_name, args.suite_name);
        break;
      case "get_command":
        text = getCommand(args.app_name, args.command_name);
        break;
      case "get_class":
        text = getClass(args.app_name, args.class_name);
        break;
      case "get_enumeration":
        text = getEnumeration(args.app_name, args.enum_name);
        break;
      case "search_dictionary":
        text = searchDictionary(args.app_name, args.query);
        break;
      default:
        return {
          content: [{ type: "text", text: `Unknown tool: ${name}` }],
          isError: true,
        };
    }
    return { content: [{ type: "text", text }] };
  } catch (err) {
    return {
      content: [{ type: "text", text: err.message }],
      isError: true,
    };
  }
});

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

const transport = new StdioServerTransport();
await server.connect(transport);
