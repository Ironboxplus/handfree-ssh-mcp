import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import yaml from "js-yaml";
import { z } from "zod";
import { ToolError } from "../utils/tool-error.js";

const word = z.string().min(1).refine(s => !s.includes("\0"), "NUL is not allowed");
const argv = z.array(word).min(1);
const settings = z.record(word);
export const componentSchema = z.object({
  id: z.string().regex(/^[a-z][a-z0-9-]*$/),
  target: z.enum(["local", "ssh"]),
  description: z.string(),
  setup: word.optional(),
  defaults: settings.default({}),
  entry: argv,
  version: argv,
  source: z.object({ kind: z.string(), location: z.string(), package: z.string().optional() }).strict().optional(),
  install: argv.optional(),
  update: argv.optional(),
  env: z.record(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/), word).default({}),
  skills: z.object({ list: argv, show: argv }).strict().optional(),
}).strict();
export const manifestSchema = z.object({
  schemaVersion: z.literal(1),
  id: z.string().regex(/^[a-z][a-z0-9-]*$/),
  description: z.string(),
  components: z.array(componentSchema).min(1),
}).strict().superRefine((m, ctx) => {
  if (new Set(m.components.map(c => c.id)).size !== m.components.length)
    ctx.addIssue({code: "custom", message: "Duplicate component id"});
});
const registration = z.object({
  manifest: word,
  enabled: z.boolean().default(true),
  settings: settings.default({}),
  connections: z.record(settings).default({}),
}).strict();
const registrySchema = z.object({ schemaVersion: z.literal(1), plugins: z.record(registration) }).strict();
export type Component = z.infer<typeof componentSchema>;
export type Manifest = z.infer<typeof manifestSchema>;
export type Registration = z.infer<typeof registration>;

export function defaultCatalogPath(args = process.argv.slice(2)): string {
  const i = args.indexOf("--plugins");
  if (i >= 0 && (!args[i + 1] || args[i + 1].startsWith("--")))
    throw new ToolError("INVALID_CONFIGURATION", "--plugins requires a registry file path");
  return path.resolve(i >= 0 ? args[i + 1] : process.env.HANDFREE_PLUGINS_CONFIG ||
    path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config"), "handfree-ssh-mcp", "plugins.yaml"));
}

/** Trusted user configuration is re-read per request; manifests are never executable JS. */
export class PluginCatalog {
  constructor(readonly file = defaultCatalogPath()) {}

  read(): Array<{manifest: Manifest; registration: Registration}> {
    if (!fs.existsSync(this.file)) return [];
    try {
      const registry = registrySchema.parse(yaml.load(fs.readFileSync(this.file, "utf8")));
      return Object.entries(registry.plugins).filter(([, item]) => item.enabled).map(([id, item]) => {
        const manifest = manifestSchema.parse(yaml.load(fs.readFileSync(path.resolve(path.dirname(this.file), item.manifest), "utf8")));
        if (manifest.id !== id) throw new Error(`Manifest id ${manifest.id} does not match registry key ${id}`);
        return {manifest, registration: item};
      });
    } catch (error) {
      throw new ToolError("INVALID_CONFIGURATION", `Invalid plugin catalog ${this.file}: ${(error as Error).message}`);
    }
  }

  resolve(id: string, componentId?: string) {
    const plugin = this.read().find(p => p.manifest.id === id);
    if (!plugin) throw new ToolError("INVALID_CONFIGURATION", `Unknown or disabled plugin: ${id}`);
    const component = componentId ? plugin.manifest.components.find(c => c.id === componentId) :
      plugin.manifest.components.length === 1 ? plugin.manifest.components[0] : undefined;
    if (!component) throw new ToolError("INVALID_CONFIGURATION", `Select a component: ${plugin.manifest.components.map(c => c.id).join(", ")}`);
    return {...plugin, component};
  }
}

export function expand(value: string, variables: Record<string, string>): string {
  return value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_, key: string) => {
    if (!Object.hasOwn(variables, key) || !variables[key])
      throw new ToolError("INVALID_CONFIGURATION", `Missing plugin setting: ${key}`);
    return variables[key];
  });
}
export function shellQuote(value: string): string {
  if (value.includes("\0")) throw new ToolError("INVALID_CONFIGURATION", "NUL is not allowed");
  return "'" + value.replace(/'/g, "'\\''") + "'";
}
