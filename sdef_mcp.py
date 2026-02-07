#!/usr/bin/env python3
"""
sdef-mcp: MCP server for reading macOS AppleScript dictionaries (SDEF).

Provides fine-grained, token-efficient access to app scripting definitions
so AI assistants can write accurate AppleScript without hallucinating APIs.

Tools:
  list_scriptable_apps  — discover what's scriptable
  get_app_suites        — suite overview for an app
  get_suite_detail      — commands, classes, enums in a suite
  get_command           — full command signature
  get_class             — full class detail (props, elements, inheritance)
  get_enumeration       — enum values
  search_dictionary     — keyword search across an app's dictionary

Usage:
  pip install mcp
  python3 sdef_mcp.py
"""

import os
import subprocess
import plistlib
import xml.etree.ElementTree as ET
from pathlib import Path
from typing import Optional

from mcp.server.fastmcp import FastMCP

mcp = FastMCP(
    "sdef-reader",
    description="Read macOS app AppleScript scripting dictionaries (SDEF)",
)

# ---------------------------------------------------------------------------
# SDEF XML Parser
# ---------------------------------------------------------------------------

class SDEFParser:
    """Parses SDEF XML into structured Python dicts."""

    def __init__(self, xml_string: str):
        try:
            self.root = ET.fromstring(xml_string)
        except ET.ParseError as e:
            raise ValueError(f"Malformed SDEF XML: {e}")
        self.title = self.root.get("title", "")
        self.suites: list[dict] = []
        self._parse()

    # -- type resolution helpers --

    @staticmethod
    def _resolve_type(el: ET.Element) -> str:
        """Get type string from an element that may use a type= attr or child <type> elements."""
        if el.get("type"):
            t = el.get("type", "any")
            if el.get("list") == "yes":
                t = f"list of {t}"
            return t
        type_els = el.findall("type")
        if type_els:
            parts = []
            for t in type_els:
                name = t.get("type", "any")
                if t.get("list") == "yes":
                    name = f"list of {name}"
                parts.append(name)
            return " | ".join(parts)
        return "any"

    # -- element parsers --

    def _parse(self):
        for suite_el in self.root.findall("suite"):
            suite = {
                "name": suite_el.get("name", ""),
                "code": suite_el.get("code", ""),
                "description": suite_el.get("description", ""),
                "commands": [],
                "classes": [],
                "enumerations": [],
            }
            for cmd_el in suite_el.findall("command"):
                suite["commands"].append(self._parse_command(cmd_el))
            for cls_el in suite_el.findall("class"):
                suite["classes"].append(self._parse_class(cls_el))
            for ext_el in suite_el.findall("class-extension"):
                cls = self._parse_class(ext_el)
                cls["is_extension"] = True
                suite["classes"].append(cls)
            for enum_el in suite_el.findall("enumeration"):
                suite["enumerations"].append(self._parse_enum(enum_el))
            self.suites.append(suite)

    def _parse_command(self, el: ET.Element) -> dict:
        cmd: dict = {
            "name": el.get("name", ""),
            "code": el.get("code", ""),
            "description": el.get("description", ""),
            "direct_parameter": None,
            "parameters": [],
            "result": None,
        }
        dp = el.find("direct-parameter")
        if dp is not None:
            cmd["direct_parameter"] = {
                "type": self._resolve_type(dp),
                "description": dp.get("description", ""),
                "optional": dp.get("optional", "no") == "yes",
            }
        for p in el.findall("parameter"):
            cmd["parameters"].append({
                "name": p.get("name", ""),
                "code": p.get("code", ""),
                "type": self._resolve_type(p),
                "description": p.get("description", ""),
                "optional": p.get("optional", "no") == "yes",
            })
        res = el.find("result")
        if res is not None:
            cmd["result"] = {
                "type": self._resolve_type(res),
                "description": res.get("description", ""),
            }
        return cmd

    def _parse_class(self, el: ET.Element) -> dict:
        cls: dict = {
            "name": el.get("name", ""),
            "code": el.get("code", ""),
            "description": el.get("description", ""),
            "inherits": el.get("inherits", ""),
            "plural": el.get("plural", ""),
            "properties": [],
            "elements": [],
            "responds_to": [],
            "is_extension": False,
        }
        for p in el.findall("property"):
            cls["properties"].append({
                "name": p.get("name", ""),
                "code": p.get("code", ""),
                "type": self._resolve_type(p),
                "access": p.get("access", "rw"),
                "description": p.get("description", ""),
            })
        for e in el.findall("element"):
            cls["elements"].append({
                "type": self._resolve_type(e),
                "access": e.get("access", "rw"),
            })
        for rt in el.findall("responds-to"):
            cmd_name = rt.get("command", "") or rt.get("name", "")
            if cmd_name:
                cls["responds_to"].append(cmd_name)
        return cls

    def _parse_enum(self, el: ET.Element) -> dict:
        enum: dict = {
            "name": el.get("name", ""),
            "code": el.get("code", ""),
            "values": [],
        }
        for v in el.findall("enumerator"):
            enum["values"].append({
                "name": v.get("name", ""),
                "code": v.get("code", ""),
                "description": v.get("description", ""),
            })
        return enum


# ---------------------------------------------------------------------------
# App discovery
# ---------------------------------------------------------------------------

def _find_app_path(name: str) -> Optional[str]:
    """Locate an app bundle by display name."""
    # Try mdfind first (fast, indexed)
    try:
        result = subprocess.run(
            [
                "mdfind",
                f"kMDItemDisplayName == '{name}'"
                " && kMDItemContentType == 'com.apple.application-bundle'",
            ],
            capture_output=True,
            text=True,
            timeout=10,
        )
        paths = [p.strip() for p in result.stdout.strip().split("\n") if p.strip()]
        if paths:
            # prefer /Applications and /System/Applications
            for p in paths:
                if p.startswith("/Applications") or p.startswith("/System/Applications"):
                    return p
            return paths[0]
    except Exception:
        pass

    # Fallback: check common directories
    for base in [
        "/Applications",
        "/System/Applications",
        os.path.expanduser("~/Applications"),
    ]:
        candidate = os.path.join(base, f"{name}.app")
        if os.path.exists(candidate):
            return candidate

    return None


def _get_sdef_xml(app_path: str) -> str:
    """Run the macOS `sdef` command to extract an app's scripting dictionary XML."""
    result = subprocess.run(
        ["sdef", app_path],
        capture_output=True,
        text=True,
        timeout=30,
    )
    if result.returncode != 0:
        raise ValueError(
            f"Could not get SDEF for {app_path}. "
            f"The app may not be scriptable. stderr: {result.stderr.strip()}"
        )
    return result.stdout


# ---------------------------------------------------------------------------
# Cache (in-memory, per-process)
# ---------------------------------------------------------------------------

_sdef_cache: dict[str, SDEFParser] = {}


def _get_parser(app_name: str) -> SDEFParser:
    """Return a cached SDEFParser for an app, parsing on first access."""
    if app_name not in _sdef_cache:
        app_path = _find_app_path(app_name)
        if not app_path:
            raise ValueError(
                f"App '{app_name}' not found. "
                "Use list_scriptable_apps() to see available apps."
            )
        xml = _get_sdef_xml(app_path)
        _sdef_cache[app_name] = SDEFParser(xml)
    return _sdef_cache[app_name]


# ---------------------------------------------------------------------------
# Formatters — compact, token-efficient plain text
# ---------------------------------------------------------------------------

def _fmt_suites_overview(parser: SDEFParser) -> str:
    lines = []
    for s in parser.suites:
        desc = s["description"] or "—"
        lines.append(f"■ {s['name']}")
        lines.append(f"  {desc}")
        lines.append(
            f"  {len(s['commands'])} commands · "
            f"{len(s['classes'])} classes · "
            f"{len(s['enumerations'])} enums"
        )
        lines.append("")
    return "\n".join(lines).rstrip()


def _fmt_suite_detail(suite: dict) -> str:
    lines = [f"{'═' * 3} {suite['name']} {'═' * 3}"]
    if suite["description"]:
        lines.append(suite["description"])
    lines.append("")

    if suite["commands"]:
        lines.append("COMMANDS:")
        for cmd in suite["commands"]:
            sig = _fmt_command_signature(cmd)
            lines.append(f"  {sig}")
        lines.append("")

    if suite["classes"]:
        lines.append("CLASSES:")
        for cls in suite["classes"]:
            inh = f" : {cls['inherits']}" if cls["inherits"] else ""
            ext = " [ext]" if cls.get("is_extension") else ""
            desc = f" — {cls['description']}" if cls["description"] else ""
            lines.append(
                f"  {cls['name']}{inh}{ext}"
                f" ({len(cls['properties'])}p {len(cls['elements'])}e)"
                f"{desc}"
            )
        lines.append("")

    if suite["enumerations"]:
        lines.append("ENUMS:")
        for enum in suite["enumerations"]:
            vals = " | ".join(v["name"] for v in enum["values"])
            lines.append(f"  {enum['name']}: {vals}")
        lines.append("")

    return "\n".join(lines).rstrip()


def _fmt_command_signature(cmd: dict) -> str:
    """One-line command signature."""
    parts = [cmd["name"]]
    if cmd["direct_parameter"]:
        dp = cmd["direct_parameter"]
        opt = "?" if dp["optional"] else ""
        parts.append(f"<{dp['type']}{opt}>")
    for p in cmd["parameters"]:
        opt = "?" if p["optional"] else ""
        parts.append(f"{p['name']}:{p['type']}{opt}")
    if cmd["result"]:
        parts.append(f"→ {cmd['result']['type']}")
    desc = f"  // {cmd['description']}" if cmd["description"] else ""
    return " ".join(parts) + desc


def _fmt_command_detail(cmd: dict, suite_name: str = "") -> str:
    header = f"COMMAND: {cmd['name']}"
    if suite_name:
        header += f"  [{suite_name}]"
    lines = [header]
    if cmd["description"]:
        lines.append(f"  {cmd['description']}")

    if cmd["direct_parameter"]:
        dp = cmd["direct_parameter"]
        opt = " [optional]" if dp["optional"] else ""
        lines.append(f"  Direct param: {dp['type']}{opt}")
        if dp["description"]:
            lines.append(f"    {dp['description']}")

    if cmd["parameters"]:
        lines.append("  Params:")
        for p in cmd["parameters"]:
            opt = " [optional]" if p["optional"] else ""
            desc = f" — {p['description']}" if p["description"] else ""
            lines.append(f"    {p['name']}: {p['type']}{opt}{desc}")

    if cmd["result"]:
        desc = f" — {cmd['result']['description']}" if cmd["result"]["description"] else ""
        lines.append(f"  Returns: {cmd['result']['type']}{desc}")

    return "\n".join(lines)


def _fmt_class_detail(cls: dict, suite_name: str = "") -> str:
    header = f"CLASS: {cls['name']}"
    if suite_name:
        header += f"  [{suite_name}]"
    lines = [header]
    if cls["inherits"]:
        lines.append(f"  Inherits: {cls['inherits']}")
    if cls["plural"]:
        lines.append(f"  Plural: {cls['plural']}")
    if cls.get("is_extension"):
        lines.append("  (class extension)")
    if cls["description"]:
        lines.append(f"  {cls['description']}")

    if cls["properties"]:
        lines.append("  Properties:")
        for p in cls["properties"]:
            acc = f" [{p['access']}]" if p["access"] != "rw" else ""
            desc = f" — {p['description']}" if p["description"] else ""
            lines.append(f"    {p['name']}: {p['type']}{acc}{desc}")

    if cls["elements"]:
        elems = ", ".join(e["type"] for e in cls["elements"])
        lines.append(f"  Elements: {elems}")

    if cls["responds_to"]:
        lines.append(f"  Responds to: {', '.join(cls['responds_to'])}")

    return "\n".join(lines)


def _fmt_enum_detail(enum: dict, suite_name: str = "") -> str:
    header = f"ENUM: {enum['name']}"
    if suite_name:
        header += f"  [{suite_name}]"
    lines = [header]
    for v in enum["values"]:
        desc = f" — {v['description']}" if v["description"] else ""
        lines.append(f"  {v['name']}{desc}")
    return "\n".join(lines)


# ---------------------------------------------------------------------------
# MCP Tools
# ---------------------------------------------------------------------------

@mcp.tool()
def list_scriptable_apps(search_dir: str = "/Applications") -> str:
    """List macOS applications that have AppleScript scripting dictionaries.

    Args:
        search_dir: Directory to search. Defaults to /Applications (also checks /System/Applications).
    """
    scriptable: list[str] = []
    dirs_to_check = [search_dir]
    if search_dir == "/Applications":
        dirs_to_check.append("/System/Applications")
        dirs_to_check.append(os.path.expanduser("~/Applications"))

    for d in dirs_to_check:
        base = Path(d)
        if not base.exists():
            continue
        for app_path in sorted(base.glob("**/*.app")):
            info_plist = app_path / "Contents" / "Info.plist"
            if not info_plist.exists():
                continue
            try:
                with open(info_plist, "rb") as f:
                    plist = plistlib.load(f)
                if "OSAScriptingDefinition" in plist or plist.get("NSAppleScriptEnabled"):
                    scriptable.append(app_path.stem)
            except Exception:
                continue

    if not scriptable:
        return "No scriptable apps found."

    unique = sorted(set(scriptable))
    return "Scriptable apps:\n" + "\n".join(f"  {app}" for app in unique)


@mcp.tool()
def get_app_suites(app_name: str) -> str:
    """Get a compact overview of all scripting suites in an app.

    Shows suite names, descriptions, and counts of commands/classes/enums.
    This is the recommended starting point for exploring an unfamiliar app.

    Args:
        app_name: Application name, e.g. "Safari", "Finder", "Mail"
    """
    parser = _get_parser(app_name)
    title = f"Dictionary: {parser.title or app_name}\n\n"
    return title + _fmt_suites_overview(parser)


@mcp.tool()
def get_suite_detail(app_name: str, suite_name: str) -> str:
    """Get the full contents of a suite — commands (as signatures), classes, and enums.

    Use get_app_suites first to see which suites are available.

    Args:
        app_name: Application name
        suite_name: Suite name (case-insensitive)
    """
    parser = _get_parser(app_name)
    for suite in parser.suites:
        if suite["name"].lower() == suite_name.lower():
            return _fmt_suite_detail(suite)
    available = ", ".join(s["name"] for s in parser.suites)
    return f"Suite '{suite_name}' not found. Available: {available}"


@mcp.tool()
def get_command(app_name: str, command_name: str) -> str:
    """Get full details for a command — parameters, types, result.

    If the command exists in multiple suites, all definitions are shown.

    Args:
        app_name: Application name
        command_name: Command name (case-insensitive), e.g. "make", "close", "save"
    """
    parser = _get_parser(app_name)
    results = []
    for suite in parser.suites:
        for cmd in suite["commands"]:
            if cmd["name"].lower() == command_name.lower():
                results.append(_fmt_command_detail(cmd, suite["name"]))

    if results:
        return "\n\n".join(results)

    # Not found — list available commands
    all_cmds = sorted({
        cmd["name"]
        for suite in parser.suites
        for cmd in suite["commands"]
    })
    return f"Command '{command_name}' not found.\nAvailable: {', '.join(all_cmds)}"


@mcp.tool()
def get_class(app_name: str, class_name: str) -> str:
    """Get full details for a class — properties, elements, inheritance, responds-to.

    If the class has extensions in other suites, those are shown too.

    Args:
        app_name: Application name
        class_name: Class name (case-insensitive), e.g. "document", "window", "tab"
    """
    parser = _get_parser(app_name)
    results = []
    for suite in parser.suites:
        for cls in suite["classes"]:
            if cls["name"].lower() == class_name.lower():
                results.append(_fmt_class_detail(cls, suite["name"]))

    if results:
        return "\n\n".join(results)

    all_classes = sorted({
        cls["name"]
        for suite in parser.suites
        for cls in suite["classes"]
    })
    return f"Class '{class_name}' not found.\nAvailable: {', '.join(all_classes)}"


@mcp.tool()
def get_enumeration(app_name: str, enum_name: str) -> str:
    """Get all values for a specific enumeration type.

    Args:
        app_name: Application name
        enum_name: Enumeration name (case-insensitive), e.g. "save options", "printing error handling"
    """
    parser = _get_parser(app_name)
    results = []
    for suite in parser.suites:
        for enum in suite["enumerations"]:
            if enum["name"].lower() == enum_name.lower():
                results.append(_fmt_enum_detail(enum, suite["name"]))

    if results:
        return "\n\n".join(results)

    all_enums = sorted({
        enum["name"]
        for suite in parser.suites
        for enum in suite["enumerations"]
    })
    return f"Enum '{enum_name}' not found.\nAvailable: {', '.join(all_enums)}"


@mcp.tool()
def search_dictionary(app_name: str, query: str) -> str:
    """Search an app's entire dictionary for commands, classes, properties, or enums matching a keyword.

    Searches names and descriptions. Useful when you're not sure what suite something is in.

    Args:
        app_name: Application name
        query: Search term (case-insensitive), e.g. "tab", "url", "save", "window"
    """
    parser = _get_parser(app_name)
    q = query.lower()
    hits: list[str] = []

    for suite in parser.suites:
        sn = suite["name"]

        for cmd in suite["commands"]:
            if q in cmd["name"].lower() or q in (cmd.get("description") or "").lower():
                sig = _fmt_command_signature(cmd)
                hits.append(f"  CMD  [{sn}] {sig}")

        for cls in suite["classes"]:
            if q in cls["name"].lower() or q in (cls.get("description") or "").lower():
                inh = f" : {cls['inherits']}" if cls["inherits"] else ""
                hits.append(
                    f"  CLS  [{sn}] {cls['name']}{inh}"
                    f" ({len(cls['properties'])}p {len(cls['elements'])}e)"
                )

            # Also search within properties
            for prop in cls["properties"]:
                if q in prop["name"].lower() or q in (prop.get("description") or "").lower():
                    acc = f" [{prop['access']}]" if prop["access"] != "rw" else ""
                    hits.append(
                        f"  PROP [{sn}] {cls['name']}.{prop['name']}: {prop['type']}{acc}"
                    )

        for enum in suite["enumerations"]:
            if q in enum["name"].lower():
                vals = " | ".join(v["name"] for v in enum["values"])
                hits.append(f"  ENUM [{sn}] {enum['name']}: {vals}")
            else:
                for v in enum["values"]:
                    if q in v["name"].lower():
                        hits.append(
                            f"  VAL  [{sn}] {enum['name']}.{v['name']}"
                            f"{' — ' + v['description'] if v['description'] else ''}"
                        )

    if not hits:
        return f"No results for '{query}' in {app_name}'s dictionary."

    return f"Search '{query}' in {app_name} ({len(hits)} hits):\n" + "\n".join(hits)


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------

if __name__ == "__main__":
    mcp.run()
