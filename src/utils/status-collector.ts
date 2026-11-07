import { Client, ClientChannel } from "ssh2";
import { ServerStatus } from "../models/types.js";
import { Logger } from "./logger.js";

/** Default wall-clock budget for one server's status collection. */
export const DEFAULT_STATUS_COLLECT_TIMEOUT_MS = 15_000;

/**
 * Remote probe script (POSIX sh). ONE exec channel, KEY=value lines.
 *
 * Previously we opened ~17 parallel exec channels with no timeout. That could:
 *  - exhaust OpenSSH MaxSessions (default 10) and starve later tools
 *  - hang forever on stuck remotes (nvidia-smi, top, systemctl, dead peer)
 *  - make refreshStatus / list-servers {refresh:true} appear permanently stuck
 *
 * Design constraints (from real-machine smoke across mixed fleets):
 *  - POSIX sh only (dash/busybox/ash — no bashisms)
 *  - always exit 0 so partial output is still delivered
 *  - GPU / systemctl probes time-boxed when GNU `timeout` exists
 *  - single channel so the client-side timeout can kill one stream cleanly
 *
 * The script is shipped base64-encoded so remote quoting cannot break it.
 */
const STATUS_PROBE_SCRIPT = `set +e
echo __STATUS_BEGIN__
printf 'HOSTNAME='
hostname 2>/dev/null
echo
printf 'IP='
(ip -o addr show 2>/dev/null | awk '{print $4}' | grep -v '^127\\.' | cut -d/ -f1 | tr '\\n' ' ') 2>/dev/null
echo
printf 'OS_NAME='
uname -s 2>/dev/null
echo
printf 'OS_VERSION='
( (grep '^PRETTY_NAME=' /etc/os-release 2>/dev/null | cut -d= -f2 | tr -d '"') || uname -o 2>/dev/null )
echo
printf 'KERNEL='
uname -r 2>/dev/null
echo
printf 'UPTIME='
(uptime -p 2>/dev/null || uptime 2>/dev/null | awk -F'up ' '{print $2}' | awk -F, '{print $1}')
echo
printf 'DISK='
(df -h / 2>/dev/null | tail -1 | awk '{print "free:" $4 " total:" $2}')
echo
printf 'MEMORY='
(free -h 2>/dev/null | awk '/^Mem:/{print "free:" $7 " total:" $2}')
echo
printf 'CPU_NAME='
(
  (lscpu 2>/dev/null | awk -F: '/^Model name:/{gsub(/^ +/,"",$2); print $2; exit}') ||
  (awk -F: '/model name/{gsub(/^ +/,"",$2); print $2; exit}' /proc/cpuinfo 2>/dev/null) ||
  (echo "$(nproc 2>/dev/null || echo ?)-core $(uname -m 2>/dev/null || echo unknown) processor")
)
echo
printf 'CPU_USAGE='
(awk '/^cpu /{u=$2+$4; t=$2+$3+$4+$5; if(t>0) printf "%.1f", 100*u/t}' /proc/stat 2>/dev/null)
echo
printf 'GPUS='
(
  if command -v timeout >/dev/null 2>&1; then TMO="timeout 3"; else TMO=""; fi
  if command -v nvidia-smi >/dev/null 2>&1; then
    $TMO nvidia-smi --query-gpu=name,utilization.gpu --format=csv,noheader,nounits 2>/dev/null | while IFS= read -r line; do
      name=$(printf '%s' "$line" | cut -d, -f1 | sed 's/^ *//;s/ *$//')
      usage=$(printf '%s' "$line" | cut -d, -f2 | sed 's/^ *//;s/ *$//')
      if [ -n "$name" ]; then printf 'NVIDIA|%s|%s;' "$name" "$usage"; fi
    done
  elif command -v lspci >/dev/null 2>&1; then
    if command -v timeout >/dev/null 2>&1; then TMO2="timeout 2"; else TMO2=""; fi
    $TMO2 lspci 2>/dev/null | grep -iE 'vga|3d|display' | while IFS= read -r line; do
      gpu_name=$(printf '%s' "$line" | cut -d: -f3- | sed 's/^ *//')
      if [ -n "$gpu_name" ]; then printf 'OTHER|%s|;' "$gpu_name"; fi
    done
  fi
)
echo
printf 'GPU_PATHS='
(ls -1 /dev/dri/card* 2>/dev/null | sort -V | tr '\\n' ' ')
echo
printf 'DRIVES='
(df -h 2>/dev/null | awk 'NR>1 && $1 !~ /^(tmpfs|devtmpfs|overlay|shfs|rootfs)$/ && $6 !~ /^(\\/dev|\\/run|\\/sys|\\/proc|\\/boot|\\/usr|\\/lib)$/ && $6 != "" {printf "%s|%s|%s|%s|%s|%s;", $1,$2,$3,$4,$5,$6}')
echo
printf 'PROCESSES='
(ps aux 2>/dev/null | wc -l | tr -d ' ')
echo
printf 'THREADS='
(ps -eLf 2>/dev/null | wc -l | tr -d ' ')
echo
printf 'SERVICES_RUNNING='
(
  if command -v timeout >/dev/null 2>&1; then
    timeout 2 systemctl list-units --type=service --state=running 2>/dev/null | wc -l | tr -d ' '
  else
    systemctl list-units --type=service --state=running 2>/dev/null | wc -l | tr -d ' '
  fi
)
echo
printf 'SERVICES_INSTALLED='
(
  if command -v timeout >/dev/null 2>&1; then
    timeout 2 systemctl list-unit-files --type=service 2>/dev/null | wc -l | tr -d ' '
  else
    systemctl list-unit-files --type=service 2>/dev/null | wc -l | tr -d ' '
  fi
)
echo
echo __STATUS_END__
exit 0
`;

export type CollectSystemStatusOptions = {
  /** Wall-clock timeout for the whole probe (ms). Default 15s. */
  timeoutMs?: number;
};

/**
 * Run a single remote command with a hard client-side timeout.
 * On timeout the SSH channel is closed so the remote process is not left
 * holding a session forever.
 */
function execWithTimeout(
  client: Client,
  command: string,
  timeoutMs: number,
): Promise<string> {
  return new Promise((resolve, reject) => {
    let settled = false;
    let stream: ClientChannel | undefined;
    let stdout = "";
    let stderr = "";

    const settle = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn();
    };

    const timer = setTimeout(() => {
      settle(() => {
        try {
          stream?.close();
        } catch {
          // ignore
        }
        try {
          (stream as unknown as { destroy?: () => void })?.destroy?.();
        } catch {
          // ignore
        }
        reject(new Error(`status collection timed out after ${timeoutMs}ms`));
      });
    }, timeoutMs);

    try {
      client.exec(command, (err, s) => {
        if (settled) {
          try {
            s?.close();
          } catch {
            // ignore
          }
          return;
        }
        if (err) {
          settle(() => reject(err));
          return;
        }
        stream = s;
        s.on("data", (chunk: Buffer) => {
          stdout += chunk.toString();
        });
        s.stderr.on("data", (chunk: Buffer) => {
          stderr += chunk.toString();
        });
        s.on("close", (code: number | null) => {
          settle(() => {
            const text = (stdout || stderr).trim();
            // Accept any parseable probe output even if the shell exited non-zero
            // (partial collection is better than marking the host unreachable).
            if (
              code === 0 ||
              text.includes("__STATUS_BEGIN__") ||
              text.includes("HOSTNAME=")
            ) {
              resolve(text);
            } else {
              reject(
                new Error(
                  `status probe exited with code ${code ?? "null"}${stderr ? `: ${stderr.trim().slice(0, 200)}` : ""}`,
                ),
              );
            }
          });
        });
        s.on("error", (streamErr: Error) => {
          settle(() => reject(streamErr));
        });
      });
    } catch (err) {
      settle(() => reject(err instanceof Error ? err : new Error(String(err))));
    }
  });
}

function parseKvLines(output: string): Map<string, string> {
  const map = new Map<string, string>();
  for (const rawLine of output.split("\n")) {
    const line = rawLine.trimEnd();
    if (!line || line.startsWith("__STATUS_")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    const value = line.slice(eq + 1).trim();
    map.set(key, value);
  }
  return map;
}

/**
 * Build the remote command. Base64 avoids remote quoting breakage on mixed fleets.
 * Falls back to a tiny inline probe if base64 is unavailable on the remote.
 */
function buildProbeCommand(): string {
  const b64 = Buffer.from(STATUS_PROBE_SCRIPT, "utf8").toString("base64");
  // Prefer base64 -d (GNU) then base64 --decode (BSD). Always exit 0 from the
  // outer shell so ssh2 sees a clean channel close with stdout.
  return (
    `(echo ${b64} | (base64 -d 2>/dev/null || base64 --decode 2>/dev/null || openssl base64 -d -A 2>/dev/null) | sh) ` +
    `|| sh -c 'echo __STATUS_BEGIN__; printf HOSTNAME=; hostname; echo; printf OS_NAME=; uname -s; echo; echo __STATUS_END__'`
  );
}

/**
 * Collect system status information from a remote server.
 *
 * Always time-bounded: never hangs the caller indefinitely when a remote
 * command or SSH channel stalls (common on GPU hosts with a wedged nvidia-smi).
 */
export async function collectSystemStatus(
  client: Client,
  connectionName: string,
  options: CollectSystemStatusOptions = {},
): Promise<ServerStatus> {
  const timeoutMs =
    typeof options.timeoutMs === "number" &&
    Number.isFinite(options.timeoutMs) &&
    options.timeoutMs > 0
      ? Math.floor(options.timeoutMs)
      : DEFAULT_STATUS_COLLECT_TIMEOUT_MS;

  const status: ServerStatus = {
    reachable: true,
    lastUpdated: new Date().toISOString(),
  };

  try {
    const raw = await execWithTimeout(client, buildProbeCommand(), timeoutMs);
    const kv = parseKvLines(raw);

    const hostname = kv.get("HOSTNAME");
    if (hostname) status.hostname = hostname;

    const ipRaw = kv.get("IP");
    if (ipRaw) {
      status.ipAddresses = ipRaw
        .split(/\s+/)
        .map((ip) => ip.trim())
        .filter((ip) => ip && !ip.includes("127.0.0.1"));
      if (status.ipAddresses.length === 0) delete status.ipAddresses;
    }

    const osName = kv.get("OS_NAME");
    if (osName) status.osName = osName;

    const osVersion = kv.get("OS_VERSION");
    if (osVersion) status.osVersion = osVersion;

    const kernel = kv.get("KERNEL");
    if (kernel) status.kernelVersion = kernel;

    const uptime = kv.get("UPTIME");
    if (uptime) status.uptime = uptime;

    const disk = kv.get("DISK");
    if (disk) {
      const diskMatch = disk.match(/free:(\S+)\s+total:(\S+)/);
      if (diskMatch) {
        status.diskSpace = { free: diskMatch[1], total: diskMatch[2] };
      }
    }

    const memory = kv.get("MEMORY");
    if (memory) {
      const memMatch = memory.match(/free:(\S+)\s+total:(\S+)/);
      if (memMatch) {
        status.memory = { free: memMatch[1], total: memMatch[2] };
      }
    }

    const cpuName = kv.get("CPU_NAME");
    if (cpuName) {
      status.cpu = { name: cpuName };
    }
    const cpuUsage = kv.get("CPU_USAGE");
    if (status.cpu && cpuUsage && cpuUsage !== "N/A") {
      const n = parseFloat(cpuUsage);
      if (!Number.isNaN(n)) {
        status.cpu.usage = `${n.toFixed(1)}%`;
      }
    }

    const gpuPathsRaw = kv.get("GPU_PATHS") ?? "";
    const gpuPaths = gpuPathsRaw.split(/\s+/).filter((p) => p.trim());
    const gpusRaw = kv.get("GPUS") ?? "";
    if (gpusRaw.trim()) {
      const gpus: Array<{ name: string; usage?: string; path?: string }> = [];
      const gpuLines = gpusRaw.split(";").filter((line) => line.trim());
      gpuLines.forEach((line, index) => {
        const parts = line.split("|");
        if (parts.length < 2) return;
        const name = parts[1].trim();
        const usage = parts[2]?.trim();
        if (!name || name === "N/A") return;
        const gpu: { name: string; usage?: string; path?: string } = { name };
        if (usage && usage !== "N/A" && !Number.isNaN(parseFloat(usage))) {
          gpu.usage = `${parseFloat(usage).toFixed(1)}%`;
        }
        if (gpuPaths[index]) gpu.path = gpuPaths[index];
        gpus.push(gpu);
      });
      if (gpus.length > 0) status.gpus = gpus;
    }

    const drivesRaw = kv.get("DRIVES") ?? "";
    if (drivesRaw.trim()) {
      const drives: Array<{
        device: string;
        mountPoint: string;
        total: string;
        used: string;
        free: string;
        usagePercent: string;
        filesystem?: string;
      }> = [];
      for (const line of drivesRaw.split(";").filter((l) => l.trim())) {
        const parts = line.split("|");
        if (parts.length < 6) continue;
        const device = parts[0].trim();
        const total = parts[1].trim();
        const used = parts[2].trim();
        const free = parts[3].trim();
        const usagePercent = parts[4].trim();
        const mountPoint = parts[5].trim();
        if (device && mountPoint) {
          drives.push({ device, mountPoint, total, used, free, usagePercent });
        }
      }
      if (drives.length > 0) status.drives = drives;
    }

    const processesRaw = kv.get("PROCESSES");
    const threadsRaw = kv.get("THREADS");
    if (processesRaw !== undefined || threadsRaw !== undefined) {
      const processCount = parseInt(processesRaw ?? "0", 10) - 1;
      const threadCount = parseInt(threadsRaw ?? "0", 10) - 1;
      status.processes = {
        running: Math.max(0, Number.isFinite(processCount) ? processCount : 0),
        threads: Math.max(0, Number.isFinite(threadCount) ? threadCount : 0),
      };
    }

    const svcRunningRaw = kv.get("SERVICES_RUNNING");
    const svcInstalledRaw = kv.get("SERVICES_INSTALLED");
    if (svcRunningRaw !== undefined || svcInstalledRaw !== undefined) {
      const runningCount = parseInt(svcRunningRaw ?? "0", 10) - 1;
      const installedCount = parseInt(svcInstalledRaw ?? "0", 10) - 1;
      status.services = {
        running: Math.max(0, Number.isFinite(runningCount) ? runningCount : 0),
        installed: Math.max(0, Number.isFinite(installedCount) ? installedCount : 0),
      };
    }

    // If the probe returned no useful keys at all, treat as unreachable.
    if (!hostname && !osName && !kv.get("KERNEL") && kv.size === 0) {
      status.reachable = false;
    }
  } catch (error) {
    Logger.log(
      `Failed to collect system status for [${connectionName}]: ${(error as Error).message}`,
      "error",
    );
    status.reachable = false;
  }

  return status;
}
