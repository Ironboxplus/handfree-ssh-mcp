import fs from "fs";
import path from "path";
import os from "os";
import { SSHConfig, SshConnectionConfigMap } from "../models/types.js";
import { Logger } from "../utils/logger.js";

type HostOptionKey =
  | "hostname"
  | "user"
  | "port"
  | "identityfile"
  | "identityagent"
  | "identitiesonly"
  | "proxyjump";

interface Directive {
  key: string;
  value: string;
  patterns: string[];
}

interface RawHostConfig {
  alias: string;
  options: Map<HostOptionKey, string>;
}

export interface SshConfigLoadResult {
  configs: SshConnectionConfigMap;
  files: string[];
}

const SUPPORTED_KEYS = new Set<HostOptionKey>([
  "hostname",
  "user",
  "port",
  "identityfile",
  "identityagent",
  "identitiesonly",
  "proxyjump",
]);

export function getDefaultUserSshConfigPath(): string {
  return path.join(os.homedir(), ".ssh", "config");
}

export function loadSshConfigFiles(
  configPaths: string[] = [getDefaultUserSshConfigPath()],
): SshConfigLoadResult {
  const directives: Directive[] = [];
  const loadedFiles = new Set<string>();
  const visitedFiles = new Set<string>();

  for (const configPath of configPaths) {
    parseConfigFile(
      resolveLocalPath(configPath, process.cwd()),
      ["*"],
      directives,
      loadedFiles,
      visitedFiles,
    );
  }

  const rawHosts = buildRawHostConfigs(directives);
  const aliases = new Map(rawHosts.map((raw) => [raw.alias.toLowerCase(), raw.alias]));
  const configs: SshConnectionConfigMap = {};

  for (const raw of rawHosts) {
    configs[raw.alias] = toSshConfig(raw, aliases);
  }

  const configCount = Object.keys(configs).length;
  if (configCount > 0) {
    Logger.log(
      `Loaded ${configCount} host(s) from OpenSSH config: ${Array.from(loadedFiles).join(", ")}`,
      "info",
    );
  }

  return {
    configs,
    files: Array.from(loadedFiles),
  };
}

function parseConfigFile(
  filePath: string,
  inheritedPatterns: string[],
  directives: Directive[],
  loadedFiles: Set<string>,
  visitedFiles: Set<string>,
): void {
  if (!fs.existsSync(filePath)) {
    return;
  }

  let realPath = filePath;
  try {
    realPath = fs.realpathSync(filePath);
  } catch {
    realPath = path.resolve(filePath);
  }
  if (visitedFiles.has(realPath)) {
    return;
  }
  visitedFiles.add(realPath);
  loadedFiles.add(realPath);

  const dir = path.dirname(realPath);
  const lines = fs.readFileSync(realPath, "utf8").split(/\r?\n/);
  let currentPatterns = inheritedPatterns;

  for (let i = 0; i < lines.length; i++) {
    const stripped = stripComment(lines[i]).trim();
    if (!stripped) continue;

    const directiveArgs = parseDirectiveArgs(splitSshArgs(stripped));
    if (!directiveArgs) continue;

    const key = directiveArgs.key.toLowerCase();
    const rest = directiveArgs.values;
    const value = rest.join(" ");

    if (key === "host") {
      currentPatterns = rest.length > 0 ? rest : [];
      directives.push({
        key,
        value,
        patterns: currentPatterns,
      });
      continue;
    }

    if (key === "match") {
      currentPatterns = [];
      continue;
    }

    if (key === "include") {
      for (const includePattern of rest) {
        for (const includeFile of expandLocalPattern(includePattern, dir)) {
          parseConfigFile(includeFile, currentPatterns, directives, loadedFiles, visitedFiles);
        }
      }
      continue;
    }

    directives.push({
      key,
      value,
      patterns: currentPatterns,
    });
  }
}

function buildRawHostConfigs(directives: Directive[]): RawHostConfig[] {
  const aliases = new Map<string, string>();

  for (const directive of directives) {
    if (directive.key !== "host") continue;
    for (const pattern of directive.patterns) {
      if (pattern.startsWith("!")) continue;
      if (hasWildcard(pattern)) continue;
      const lower = pattern.toLowerCase();
      if (!aliases.has(lower)) {
        aliases.set(lower, pattern);
      }
    }
  }

  const rawHosts: RawHostConfig[] = [];
  for (const alias of aliases.values()) {
    const options = new Map<HostOptionKey, string>();

    for (const directive of directives) {
      if (directive.key === "host") continue;
      if (!SUPPORTED_KEYS.has(directive.key as HostOptionKey)) continue;
      if (!hostPatternsMatch(directive.patterns, alias)) continue;

      const optionKey = directive.key as HostOptionKey;
      if (!options.has(optionKey)) {
        options.set(optionKey, directive.value);
      }
    }

    rawHosts.push({ alias, options });
  }

  return rawHosts;
}

function toSshConfig(raw: RawHostConfig, aliases: Map<string, string>): SSHConfig {
  const rawHost = raw.options.get("hostname") ?? raw.alias;
  const rawUser = raw.options.get("user") ?? os.userInfo().username;
  const rawPort = raw.options.get("port") ?? "22";
  const port = parsePort(raw.alias, rawPort);

  const context = {
    alias: raw.alias,
    host: rawHost,
    user: rawUser,
    port: String(port),
  };

  const host = expandTokens(rawHost, context);
  const username = expandTokens(rawUser, { ...context, host });
  const identityFile = raw.options.get("identityfile");
  const identityAgent = raw.options.get("identityagent");
  const identitiesOnly = parseYesNo(
    raw.alias,
    "IdentitiesOnly",
    raw.options.get("identitiesonly"),
  );
  const resolvedContext = {
    alias: raw.alias,
    host,
    user: username,
    port: String(port),
  };

  const config: SSHConfig = {
    name: raw.alias,
    host,
    port,
    username,
    authOptional: true,
  };

  if (identitiesOnly !== undefined) {
    config.identitiesOnly = identitiesOnly;
  }

  const identityFileDisabled = identityFile?.toLowerCase() === "none";
  if (identityFile && !identityFileDisabled) {
    config.privateKey = resolveLocalPath(
      expandTokens(identityFile, resolvedContext),
      process.cwd(),
    );
  } else if (!identityFileDisabled && !identitiesOnly) {
    const defaultIdentity = findDefaultIdentityFile();
    if (defaultIdentity) {
      config.privateKey = defaultIdentity;
    }
  }

  if (identityAgent?.toLowerCase() === "none") {
    config.agent = false;
  } else if (identityAgent) {
    config.agent = resolveLocalPath(
      expandTokens(identityAgent, resolvedContext),
      process.cwd(),
    );
  }

  const jumpHost = resolveProxyJumpAlias(raw.alias, raw.options.get("proxyjump"), aliases);
  if (jumpHost) {
    config.jumpHost = jumpHost;
  }

  return config;
}

function resolveProxyJumpAlias(
  alias: string,
  proxyJump: string | undefined,
  aliases: Map<string, string>,
): string | undefined {
  if (!proxyJump) return undefined;
  if (proxyJump.toLowerCase() === "none") return undefined;
  if (proxyJump.includes(",")) {
    Logger.log(
      `SSH config Host '${alias}': ProxyJump chains are not supported by native jumpHost; ignoring '${proxyJump}'`,
      "info",
    );
    return undefined;
  }

  const jumpAlias = extractProxyJumpHost(proxyJump);
  if (!jumpAlias) return undefined;
  const canonical = aliases.get(jumpAlias.toLowerCase());
  if (!canonical) {
    Logger.log(
      `SSH config Host '${alias}': ProxyJump '${proxyJump}' does not reference a loaded Host alias; ignoring`,
      "info",
    );
    return undefined;
  }
  return canonical;
}

function extractProxyJumpHost(proxyJump: string): string | undefined {
  let endpoint = proxyJump.trim();
  if (!endpoint) return undefined;
  const atIndex = endpoint.lastIndexOf("@");
  if (atIndex >= 0) {
    endpoint = endpoint.slice(atIndex + 1);
  }
  if (endpoint.startsWith("[")) {
    const closeIndex = endpoint.indexOf("]");
    return closeIndex > 1 ? endpoint.slice(1, closeIndex) : undefined;
  }
  const colonIndex = endpoint.lastIndexOf(":");
  if (colonIndex > 0 && endpoint.indexOf(":") === colonIndex) {
    endpoint = endpoint.slice(0, colonIndex);
  }
  return endpoint || undefined;
}

function findDefaultIdentityFile(): string | undefined {
  const sshDir = path.join(os.homedir(), ".ssh");
  const candidates = [
    "id_ed25519",
    "id_ecdsa",
    "id_ecdsa_sk",
    "id_ed25519_sk",
    "id_rsa",
    "id_dsa",
  ];
  return candidates
    .map((name) => path.join(sshDir, name))
    .find((candidate) => fs.existsSync(candidate));
}

function parsePort(alias: string, rawPort: string): number {
  const port = Number.parseInt(rawPort, 10);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new Error(`SSH config Host '${alias}': invalid Port '${rawPort}'`);
  }
  return port;
}

function parseYesNo(
  alias: string,
  optionName: string,
  rawValue: string | undefined,
): boolean | undefined {
  if (rawValue === undefined) return undefined;
  const normalized = rawValue.toLowerCase();
  if (normalized === "yes") return true;
  if (normalized === "no") return false;
  throw new Error(`SSH config Host '${alias}': invalid ${optionName} '${rawValue}'`);
}

function hostPatternsMatch(patterns: string[], alias: string): boolean {
  if (patterns.length === 0) return false;

  let positiveMatch = false;
  for (const pattern of patterns) {
    const negated = pattern.startsWith("!");
    const body = negated ? pattern.slice(1) : pattern;
    const matched = wildcardMatch(body, alias);
    if (negated && matched) {
      return false;
    }
    if (!negated && matched) {
      positiveMatch = true;
    }
  }
  return positiveMatch;
}

function wildcardMatch(pattern: string, value: string): boolean {
  return wildcardPatternRegex(pattern).test(value);
}

function hasWildcard(value: string): boolean {
  return /[*?]/.test(value);
}

function splitSshArgs(line: string): string[] {
  const out: string[] = [];
  let current = "";
  let quote: string | null = null;

  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quote) {
      if (ch === quote) {
        quote = null;
      } else if (ch === "\\" && i + 1 < line.length && line[i + 1] === quote) {
        current += line[++i];
      } else {
        current += ch;
      }
      continue;
    }

    if (ch === "'" || ch === "\"") {
      quote = ch;
      continue;
    }
    if (/\s/.test(ch)) {
      if (current.length > 0) {
        out.push(current);
        current = "";
      }
      continue;
    }
    current += ch;
  }

  if (current.length > 0) {
    out.push(current);
  }
  return out;
}

function parseDirectiveArgs(
  args: string[],
): { key: string; values: string[] } | null {
  if (args.length === 0) return null;

  const firstEquals = args[0].indexOf("=");
  if (firstEquals > 0) {
    const key = args[0].slice(0, firstEquals);
    const firstValue = args[0].slice(firstEquals + 1);
    const values = firstValue ? [firstValue, ...args.slice(1)] : args.slice(1);
    return values.length > 0 ? { key, values } : null;
  }

  if (args.length >= 2 && args[1] === "=") {
    const values = args.slice(2);
    return values.length > 0 ? { key: args[0], values } : null;
  }

  if (args.length >= 2 && args[1].startsWith("=")) {
    const firstValue = args[1].slice(1);
    const values = firstValue ? [firstValue, ...args.slice(2)] : args.slice(2);
    return values.length > 0 ? { key: args[0], values } : null;
  }

  return args.length > 1 ? { key: args[0], values: args.slice(1) } : null;
}

function stripComment(line: string): string {
  let quote: string | null = null;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quote) {
      if (ch === quote) quote = null;
      if (ch === "\\" && i + 1 < line.length) i++;
      continue;
    }
    if (ch === "'" || ch === "\"") {
      quote = ch;
      continue;
    }
    if (ch === "#") {
      return line.slice(0, i);
    }
  }
  return line;
}

function expandLocalPattern(patternText: string, baseDir: string): string[] {
  const resolved = resolveLocalPath(patternText, baseDir);
  if (!hasWildcard(resolved)) {
    return [resolved];
  }
  return expandGlobSegments(resolved);
}

function expandGlobSegments(patternText: string): string[] {
  const parsed = path.parse(patternText);
  const relative = patternText.slice(parsed.root.length);
  const parts = relative.split(/[\\/]+/).filter(Boolean);
  let current = [parsed.root || process.cwd()];

  for (const part of parts) {
    const next: string[] = [];
    const partHasGlob = hasWildcard(part);
    const partRegex = partHasGlob ? wildcardPatternRegex(part) : null;

    for (const dir of current) {
      if (!partHasGlob) {
        next.push(path.join(dir, part));
        continue;
      }
      try {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
          if (partRegex?.test(entry.name)) {
            next.push(path.join(dir, entry.name));
          }
        }
      } catch {
        // Ignore unreadable glob roots, matching OpenSSH's permissive Include behavior.
      }
    }
    current = next;
  }

  return current.filter((candidate) => fs.existsSync(candidate));
}

function resolveLocalPath(filePath: string, baseDir: string): string {
  const expanded = expandHome(filePath);
  if (path.isAbsolute(expanded)) {
    return path.normalize(expanded);
  }
  return path.resolve(baseDir, expanded);
}

function wildcardPatternRegex(pattern: string): RegExp {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`^${escaped.replace(/\*/g, ".*").replace(/\?/g, ".")}$`, "i");
}

function expandHome(filePath: string): string {
  if (filePath === "~") return os.homedir();
  if (filePath.startsWith("~/") || filePath.startsWith("~\\")) {
    return path.join(os.homedir(), filePath.slice(2));
  }
  return filePath;
}

function expandTokens(
  value: string,
  context: { alias: string; host: string; user: string; port: string },
): string {
  return value
    .replace(/%%/g, "\0PERCENT\0")
    .replace(/%d/g, os.homedir())
    .replace(/%h/g, context.host)
    .replace(/%n/g, context.alias)
    .replace(/%p/g, context.port)
    .replace(/%r/g, context.user)
    .replace(/%u/g, os.userInfo().username)
    .replace(/\0PERCENT\0/g, "%");
}
