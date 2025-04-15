import { Injectable, Logger } from '@nestjs/common';
import { promises as fs } from 'fs';
// Remove exec import if no longer needed after refactoring
// import { exec } from 'child_process'; 
// import { promisify } from 'util';

// const execAsync = promisify(exec);

type MetricsTarget = 'container' | 'host';

@Injectable()
export class MetricsService {
  private readonly logger = new Logger(MetricsService.name);
  private readonly metricsTarget: MetricsTarget;
  private readonly hostProcPrefix = '/host/proc'; // Assuming mount point for host /proc

  constructor() {
    // Read the target mode from environment variable, default to 'container'
    this.metricsTarget = process.env.METRICS_TARGET === 'host' ? 'host' : 'container';
    this.logger.log(`Metrics target set to: ${this.metricsTarget}`);
    if (this.metricsTarget === 'host') {
      this.logger.warn(
        `Running in 'host' mode. Ensure the host's /proc filesystem is mounted read-only at ${this.hostProcPrefix} in the container. (e.g., -v /proc:${this.hostProcPrefix}:ro)`,
      );
    }
  }

  // Renamed from getContainerMetrics
  async getMetrics(): Promise<any> {
    try {
      const [cpuStats, memoryStats, diskStats, networkStats] = await Promise.all([
        this.getCpuStats(),
        this.getMemoryStats(),
        this.getDiskStats(),
        this.getNetworkStats(),
      ]);

      return {
        timestamp: new Date().toISOString(),
        target: this.metricsTarget, // Add target mode info
        cpu: cpuStats,
        memory: memoryStats,
        disk: diskStats,
        network: networkStats,
      };
    } catch (error) {
      this.logger.error(`Failed to collect metrics: ${error.message}`);
      // Return error structure consistently
      return { 
        timestamp: new Date().toISOString(),
        target: this.metricsTarget,
        error: `Failed to collect metrics: ${error.message}` 
      };
    }
  }

  // CPU 사용량 정보 수집
  private async getCpuStats(): Promise<any> {
    try {
      if (this.metricsTarget === 'host') {
        // Host mode: read /host/proc/stat
        const statData = await fs.readFile(`${this.hostProcPrefix}/stat`, 'utf8');
        const lines = statData.split('\\n');
        const cpuLine = lines.find(line => line.startsWith('cpu '));
        if (!cpuLine) {
          throw new Error('Cannot find cpu line in /host/proc/stat');
        }
        const values = cpuLine.split(/\\s+/).slice(1).map(Number);
        // user, nice, system, idle, iowait, irq, softirq, steal, guest, guest_nice
        return {
          user: values[0],
          nice: values[1],
          system: values[2],
          idle: values[3],
          iowait: values[4] ?? 0, // iowait might not always be present
          irq: values[5] ?? 0,
          softirq: values[6] ?? 0,
          steal: values[7] ?? 0,
          // Add more fields if needed
          source: `${this.hostProcPrefix}/stat`,
        };

      } else {
        // Container mode: try cgroup v2 first, then v1
        try {
            const cpuStat = await fs.readFile('/sys/fs/cgroup/cpu.stat', 'utf8');
            const lines = cpuStat.split('\\n');
            const stats = {};
            lines.forEach(line => {
              const [key, value] = line.split(' ').filter(Boolean);
              if (key && value) {
                 // Ensure values are numbers, handle potential non-numeric values gracefully
                 const numValue = parseInt(value, 10);
                 stats[key] = isNaN(numValue) ? value : numValue;
              }
            });
            if (Object.keys(stats).length > 0) {
              stats['source'] = '/sys/fs/cgroup/cpu.stat (v2)';
              return stats;
            }
        } catch (e) {
            this.logger.debug('Failed to read cgroup v2 cpu.stat, trying v1 or fallback.');
        }

        // Try cgroup v1
        try {
            const cpuUsage = await fs.readFile('/sys/fs/cgroup/cpu/cpuacct.usage', 'utf8');
            return { 
              usage_usec: parseInt(cpuUsage.trim(), 10), // Use clearer key
              source: '/sys/fs/cgroup/cpu/cpuacct.usage (v1)' 
            };
        } catch (e) {
             this.logger.warn(`No cgroup CPU stats found: ${e.message}. CPU stats will be incomplete in container mode.`);
             return { error: 'Could not read container CPU stats from cgroups.', source: 'cgroup (failed)' };
        }
      }
    } catch (error) {
      this.logger.error(`Failed to get CPU stats: ${error.message}`);
      return { error: `Failed to get CPU stats: ${error.message}` };
    }
  }

  // 메모리 사용량 정보 수집
  private async getMemoryStats(): Promise<any> {
    try {
      if (this.metricsTarget === 'host') {
        // Host mode: read /host/proc/meminfo
        const memInfoData = await fs.readFile(`${this.hostProcPrefix}/meminfo`, 'utf8');
        const lines = memInfoData.split('\\n');
        const stats = {};
        lines.forEach(line => {
          const parts = line.split(/:\s+/);
          if (parts.length === 2) {
            const key = parts[0].replace('(', '_').replace(')', ''); // Sanitize keys like MemAvailable(bytes)
            // Extract number, removing ' kB' if present
            const value = parseInt(parts[1].replace(' kB', '').trim(), 10); 
            if (!isNaN(value)) {
               // Store values in bytes (assuming kB unit from /proc/meminfo)
              stats[key] = value * 1024; 
            }
          }
        });
        stats['source'] = `${this.hostProcPrefix}/meminfo`;
        return stats;
      } else {
         // Container mode: try cgroup v2 first, then v1
         try {
             const memoryStat = await fs.readFile('/sys/fs/cgroup/memory.stat', 'utf8');
             const lines = memoryStat.split('\\n');
             const stats = {};
             lines.forEach(line => {
                 const [key, value] = line.split(' ').filter(Boolean);
                 if (key && value) {
                    const numValue = parseInt(value, 10);
                    stats[key] = isNaN(numValue) ? value : numValue;
                 }
             });
             if (Object.keys(stats).length > 0){
                stats['source'] = '/sys/fs/cgroup/memory.stat (v2)';
                return stats;
             }
         } catch (e) {
             this.logger.debug('Failed to read cgroup v2 memory.stat, trying v1.');
         }

         // Try cgroup v1
         try {
             const memoryUsage = await fs.readFile('/sys/fs/cgroup/memory/memory.usage_in_bytes', 'utf8');
             const memoryLimit = await fs.readFile('/sys/fs/cgroup/memory/memory.limit_in_bytes', 'utf8');
             // Handle potential "max" value for limit
             const limit = memoryLimit.trim().toLowerCase() === 'max' ? Infinity : parseInt(memoryLimit.trim(), 10);

             return {
                 usage_bytes: parseInt(memoryUsage.trim(), 10),
                 limit_bytes: limit,
                 source: '/sys/fs/cgroup/memory/ (v1)'
             };
         } catch (e) {
             this.logger.warn(`No cgroup memory stats found: ${e.message}. Memory stats will be incomplete in container mode.`);
             return { error: 'Could not read container memory stats from cgroups.', source: 'cgroup (failed)' };
         }
      }
    } catch (error) {
      this.logger.error(`Failed to get memory stats: ${error.message}`);
      return { error: `Failed to get memory stats: ${error.message}` };
    }
  }

  // 디스크 I/O 정보 수집
  private async getDiskStats(): Promise<any> {
     try {
       if (this.metricsTarget === 'host') {
         // Host mode: read /host/proc/diskstats
         const diskStatData = await fs.readFile(`${this.hostProcPrefix}/diskstats`, 'utf8');
         const lines = diskStatData.trim().split('\\n');
         const stats = {};
         lines.forEach(line => {
           const parts = line.trim().split(/\\s+/);
           // Format: major minor device reads reads_merged sectors read_ms writes writes_merged sectors write_ms io_in_progress io_ms weighted_io_ms discards discards_merged sectors discard_ms flush flush_ms
           if (parts.length >= 14) { 
             const device = parts[2];
             // Exclude loop devices, ram devices, etc. by default? Or filter later? Let's include all for now.
             stats[device] = {
               reads_completed: parseInt(parts[3], 10),
               // reads_merged: parseInt(parts[4], 10), // Often less interesting
               sectors_read: parseInt(parts[5], 10),
               time_reading_ms: parseInt(parts[6], 10),
               writes_completed: parseInt(parts[7], 10),
               // writes_merged: parseInt(parts[8], 10),
               sectors_written: parseInt(parts[9], 10),
               time_writing_ms: parseInt(parts[10], 10),
               io_in_progress: parseInt(parts[11], 10),
               time_io_ms: parseInt(parts[12], 10),
               weighted_time_io_ms: parseInt(parts[13], 10),
               // Add discard/flush stats if needed (parts 14+)
             };
           }
         });
         stats['source'] = `${this.hostProcPrefix}/diskstats`;
         return stats;
       } else {
          // Container mode: try cgroup v2 first, then v1
         try {
             const ioStat = await fs.readFile('/sys/fs/cgroup/io.stat', 'utf8');
             const lines = ioStat.split('\\n');
             const stats = {};
             lines.forEach(line => {
                 if (line.trim()) {
                    // Format: "maj:min rbytes=N wbytes=N rios=N wios=N dbytes=N dios=N" or per-device lines
                    // This parsing might need adjustment based on actual io.stat format variations
                    const parts = line.match(/^(\\d+:\\d+)\\s+(.*)$/);
                    if (parts && parts.length === 3) {
                       const deviceId = parts[1];
                       stats[deviceId] = {};
                       parts[2].split(' ').forEach(metric => {
                          const [key, value] = metric.split('=');
                          if (key && value) {
                             const numValue = parseInt(value, 10);
                             stats[deviceId][key] = isNaN(numValue) ? value : numValue;
                          }
                       });
                    } else {
                       // Handle potential aggregated line format if necessary
                    }
                 }
             });
             if (Object.keys(stats).length > 0) {
                 stats['source'] = '/sys/fs/cgroup/io.stat (v2)';
                 return stats;
             }
         } catch (e) {
             this.logger.debug('Failed to read cgroup v2 io.stat, trying v1.');
         }

         // Try cgroup v1 blkio
         try {
             // Reading specific files like blkio.throttle.io_service_bytes might be more reliable than io.stat
             const blkioRead = await fs.readFile('/sys/fs/cgroup/blkio/blkio.throttle.io_service_bytes', 'utf8').catch(() => '');
             const blkioWrite = await fs.readFile('/sys/fs/cgroup/blkio/blkio.throttle.io_serviced', 'utf8').catch(() => ''); // For op counts

             const stats = {};
             const parseBlkio = (data: string, valueKey: string) => {
               data.split('\\n').forEach(line => {
                 const parts = line.trim().split(' ');
                 if (parts.length === 3 && parts[1].toLowerCase() !== 'total') {
                   const device = parts[0]; // maj:min format
                   const op = parts[1].toLowerCase(); // read/write/sync/async
                   const value = parseInt(parts[2], 10);
                   if (!stats[device]) stats[device] = {};
                   if (!stats[device][op]) stats[device][op] = {};
                   stats[device][op][valueKey] = value;
                 }
               });
             };
             
             parseBlkio(blkioRead, 'bytes');
             parseBlkio(blkioWrite, 'ops');

             if (Object.keys(stats).length > 0) {
                 stats['source'] = '/sys/fs/cgroup/blkio/ (v1)';
                 return stats;
             } else {
                 throw new Error('No v1 blkio data found');
             }
         } catch(e) {
             this.logger.warn(`No cgroup disk stats found: ${e.message}. Disk stats will be incomplete in container mode.`);
             return { error: 'Could not read container disk stats from cgroups.', source: 'cgroup (failed)' };
         }
       }
     } catch (error) {
       this.logger.error(`Failed to get disk stats: ${error.message}`);
       return { error: `Failed to get disk stats: ${error.message}` };
     }
   }

   // 네트워크 통계 정보 수집
   private async getNetworkStats(): Promise<any> {
     // Network stats are typically not in cgroups, always read from /proc/net/dev
     // Adjust path based on host mode
     const networkPath = this.metricsTarget === 'host' ? `${this.hostProcPrefix}/net/dev` : '/proc/net/dev';
     try {
       const netDevData = await fs.readFile(networkPath, 'utf8');
       const lines = netDevData.trim().split('\\n').slice(2); // Skip header lines
       const stats = {};
       lines.forEach(line => {
         const parts = line.trim().split(':');
         if (parts.length < 2) return;
         const interfaceName = parts[0].trim();
         const data = parts[1].trim().split(/\\s+/).map(val => parseInt(val, 10));
         
         // Based on /proc/net/dev format:
         // Receive: bytes packets errs drop fifo frame compressed multicast
         // Transmit: bytes packets errs drop fifo colls carrier compressed
         if (data.length >= 16) { // Ensure enough fields
           stats[interfaceName] = {
             rx_bytes: data[0],
             rx_packets: data[1],
             rx_errs: data[2],
             rx_drop: data[3],
             // rx_fifo: data[4],
             // rx_frame: data[5],
             // rx_compressed: data[6],
             // rx_multicast: data[7],
             tx_bytes: data[8],
             tx_packets: data[9],
             tx_errs: data[10],
             tx_drop: data[11],
             // tx_fifo: data[12],
             // tx_colls: data[13],
             // tx_carrier: data[14],
             // tx_compressed: data[15],
           };
         }
       });
       stats['source'] = networkPath;
       return stats;
     } catch (error) {
       // Handle case where /host/proc is not mounted or readable
       if (this.metricsTarget === 'host' && error.code === 'ENOENT') {
         this.logger.error(`Failed to get network stats: ${networkPath} not found. Is /proc mounted correctly at ${this.hostProcPrefix}?`);
         return { error: `${networkPath} not found. Is host /proc mounted correctly?`, source: networkPath + ' (failed)'};
       }
       this.logger.error(`Failed to get network stats from ${networkPath}: ${error.message}`);
       return { error: `Failed to get network stats: ${error.message}`, source: networkPath + ' (failed)' };
     }
   }
 } 