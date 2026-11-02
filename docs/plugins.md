# Declarative CLI plugins

Plugins are independent programs. Handfree supplies discovery, installation commands,
SSH transport and release-specific instructions; experiment and Web logic stays in the
plugin. No REXP command mapping or REXP dependency is built into Handfree.

## User configuration

The optional registry defaults to `~/.config/handfree-ssh-mcp/plugins.yaml`
(`$XDG_CONFIG_HOME/handfree-ssh-mcp/plugins.yaml` when set). Override it with
`--plugins /absolute/path/plugins.yaml` or `HANDFREE_PLUGINS_CONFIG`.
A missing registry means no plugins. An invalid registry returns a structured error
when queried; ordinary SSH tools remain available. Files are reread on every plugin
request, so restart is unnecessary after changing a manifest.
Adding a plugin or installing it on another connected node uses the same fixed
generic MCP tools: no client tool-list refresh or Codex restart is needed. SSH node
files are watched by the core; Web observes changes on its next normal refresh.

Copy `examples/plugins/registry.example.yaml` and the manifests you need to that
personal configuration directory, then edit your paths. Do not store personal
configuration or credentials in the source repository. SSH authentication and aliases
remain in the existing SSH configuration; the plugin registry has no separate SSH client.

Each registry entry references a local, trusted manifest. Paths are relative to the
registry file. Enabled manifests must have matching ids and schemaVersion 1. A plugin
can contain several components; select one explicitly when there is more than one.

## Tool flow

1. `list-servers`: find the SSH connection alias for your target.
2. `plugin-list`: discover plugin ids, components, targets and sources.
3. `plugin-activate {plugin:"rexp", connectionName:"my-server"}`: check the installed
   version and fetch its skill catalog. Default mode is `check` and makes no installation.
4. If missing, explicitly select `mode:"install"`. To request the package manager's
   latest available version select `mode:"update"`. These use the configured commands,
   then query the actual installed version and skill catalog again. Repeated checks do
   not reinstall packages. Review running workloads before updating a worker.
5. `plugin-skill {plugin:"rexp", connectionName:"my-server", name:"platform-operations"}`:
   obtain the instructions shipped by that installed version. Fetch again after updates.
6. `plugin-run {plugin:"rexp", connectionName:"my-server", args:["runs","--json"]}`:
   call its CLI. New plugin commands require no change to Handfree.

The examples above are illustrative tool arguments. Configure the target first.
`connectionName` follows ordinary SSH tools: required if several hosts are enabled,
automatically resolved if exactly one is enabled. It is never fixed to a device name.
Local components reject `connectionName` and execute on the **MCP process host**, which
may be a Mac, Windows machine or another server.

## Manifest contract

A component declares `id`, `target` (`local` or `ssh`), `description`, `entry` and
`version` argv arrays. Optional fields:

- `source`: `kind`, `location`, optional `package`, for discovery. Downloads are done
  by the explicit `install`/`update` argv commands, **not inferred from a URL**.
- `setup`: optional installation and initialization instructions, returned by
  `plugin-list` before the program is installed. Resolve user-specific paths and
  initialization choices before installation; ask unless already supplied or explicitly
  delegated. A successful package install does not imply the plugin is ready for use.
- `install` / `update`: package manager argv arrays. Missing actions fail clearly.
- `env`: environment variables for every command, including install and version.
- `skills.list` / `skills.show`: commands returning the current catalog and one skill;
  `${skill}` is the requested name. These may return JSON or Markdown; Handfree
  returns their output without interpreting a plugin-specific business schema.

`${settingName}` substitutes a registry setting in manifest argv/environment values.
Per-connection settings override common settings. Missing/empty required values fail
before the affected command is run. Run and skill calls only require their own command
and environment settings; installer-only settings do not block an already installed plugin.
Activation checks the selected maintenance command plus its subsequent version/skill
queries before making changes. Substitution is single-pass. Runtime `args` are passed
literally, without interpolation. No arbitrary JavaScript modules are loaded.

For REXP, keep `platformRoot`, `rexpPath` and `platformPython` per server. The root is
passed through `PLATFORM_ROOT`; omitting a required root fails instead of selecting an
arbitrary directory. Existing roots are not initialized, migrated or deleted by activation.
The example assumes an existing Python installation. REXP 0.2.0 initialization
binds an existing uv/Conda manager (uv preferred), or asks the user about installing
one. Declining uses Python venv. Agent setup passes that choice explicitly;
--yes alone never authorizes manager installation. Platform and default experiment
runtimes are separate; managed environments live in platformRoot/env/. Existing
registrations are preserved. After initialization, inspect doctor.environment_manager
and update the private plugin platformPython to runtime_python if a dedicated
platform runtime was provisioned. The plugin source is official PyPI.

## Execution and lifetime

Local commands use `execFile` without a shell. Remote argv and environment values
are individually POSIX-quoted by default. For a Windows SSH target whose default shell
is `cmd.exe`, set `commandShell: powershell` in that connection's plugin registry settings.
The host then uses PowerShell's encoded command form so paths, arguments and environment
values remain literal. Existing command policies apply to the complete command, including
`env` on POSIX hosts or `powershell.exe` on Windows. Handfree never relaxes that policy.
Policies inspect the submitted shell command, not the decoded contents of PowerShell's
encoded script. They are not an argv-level sandbox for the plugin program.
SFTP continues to use existing upload/download/transfer tools and path policies.

CLI outputs are returned as `{plugin,component,target,connectionName,output}`. Errors
use existing MCP `isError` / code / message / retriable conventions. Output is limited
to 1 MiB per stream (SSH), 1 MiB combined (local); detected truncation is an error.
Remote success is checked against the existing manager's actual exit code and output
collector metadata. A zero exit code and complete output are required; marker-like text
inside logs or skills is treated as ordinary content. Other SSH command callers retain
their existing text response. A disconnected mutation is not retried automatically, since the
remote operation might already have happened. Check its state before retrying.
Normal command timeout defaults to 30 seconds (configurable up to 30 minutes through
the tool for explicit long setup operations); maintenance defaults to 5 minutes. `plugin-activate.timeout` can explicitly
allow up to 30 minutes for a slow dependency installation; the MCP client request must
also allow that duration. Preserve the manifest's package source instead of replacing
it with an ad hoc wheel URL. A timeout/disconnect may leave a partially
completed installation and cannot be rolled back by Handfree. Maintenance is serialized
per component/host in one MCP process; it is not a distributed package manager lock.

Skills are retrieved on demand, not cached indefinitely or installed into a client's
global skills directory. Connection loss does not own the scheduler or an existing Web
service. Use each program's explicit lifecycle commands. Foreground long-running servers
should not be started with `plugin-run`; the REXP Web example uses its existing persistent
`start/stop/status/logs` helper. Web's installation directory, data and lifecycle remain
independent. The current Web example controls an existing checkout; it has no published
update source or skill endpoint, so neither is fabricated by this manifest.

## Development verification

`npm run test:plugins` covers local execution, literal argv, SSH alias and root selection,
Windows PowerShell command encoding,
policy failures, installer failure, rereading skills after updates, component selection,
concurrent maintenance and timeouts. Existing SSH tests remain separate.


### Validation for this implementation

- Plugin and status tests: 14 passed, including an actual MCP client/server exchange,
  Windows probe fallback and installer timeout forwarding.
- Full suite: 739 passed, 3 failed, 11 skipped in the run including the first five
  plugin tests. The three failures were reproduced from a clean archive of origin/main
  (290c446): one missing-authentication assertion and two direct-transfer host-key fixtures.
- The actual local REXP CLI was invoked through the generic plugin host: version,
  release skills, status, queue and fixed root identity passed. No experiment scheduler
  was started and no remote worker was updated.
- Package dry run includes the new host and example manifests, excludes private SSH
  configuration and the former REXP JavaScript adapter.
- REXP Web uses `plugin-run` with `runs --json` and `run show --json`; pass both
  `--config` and `--plugins` when starting its MCP child. Its personal configuration
  selects the same node and plugin registries as the agent.


The REXP product is distributed on PyPI as `rexprun` (0.1.66+); its CLI, Python
module and plugin id remain `rexp`. The example manifest uses the official PyPI
index for install/update. Publication must precede an index-based installation.
For an existing `rexp-server` installation, stop workloads and the scheduler,
download/verify the new wheel, then uninstall the old distribution before installing
`rexprun`; both distributions own the same Python module and must not coexist.
Keep the existing data root, environments and `rexpPath` setting.

### Installation diagnostics and progress

REXP first-use setup must offer all three manager choices when none is installed: install uv (recommended), install Conda, or use existing Python venv. A recommendation must not remove Conda from the choices. Confirm the data root and manager together, follow the manifest, and retain established SSH connections.

Pip dependency downloads default to a 15-second request timeout and one retry, preserving explicit operator configuration. An unreachable source should lead to a clear failure-stage report and an agreed mirror or prepared wheelhouse rather than repeated online attempts. Offline uv initialization uses `UV_OFFLINE=true UV_FIND_LINKS=<wheelhouse>`; pip uses `PIP_NO_INDEX=1 PIP_FIND_LINKS=<wheelhouse>`. Include Python-version-specific seed packages for `uv venv --seed` as well as the default environment's complete dependencies. `UV_NO_INDEX` is not an offline-mode substitute. Resource monitoring works independently of whether REXP has been installed.

Component `defaults` supplies optional setting defaults; registry settings and per-connection settings override them. Missing settings report the registry path, target section and required keys before starting commands. Installation never automatically retries an ambiguous mutation; a timeout reports inspection and explicit retry guidance.

The REXP example downloads and checksums the current universal wheel from official PyPI, then installs its dependencies using `dependencyIndex` (default official PyPI, configurable mirror). It does not source the REXP wheel from that mirror. Installer output and elapsed-time heartbeats are forwarded through MCP progress notifications when the client supplies a progress token. Clients without progress support still receive the final result; normal SSH command logs retain output.

Keep private paths in the user registry. Reference the manifest inside the installed SSH-MCP package, rather than leaving a copied manifest stale after upgrades. The catalog reloads the referenced file on each request; reading skills after a platform upgrade does not require restarting SSH connections.

After isolated installation, `rexp init` registers a terminal command. Verify `rexp version` and `rexp doctor --json` directly in an ordinary target terminal, not only through absolute-path plugin calls. Platform root and experiment environments must match.

If the server exits with code 127 while establishing its SFTP subsystem, file transfer reports a non-retriable `SFTP_ERROR` and preserves the authenticated SSH command connection. Install or configure the server's SFTP subsystem before retrying file transfer; reconnecting SSH cannot repair a missing subsystem.
